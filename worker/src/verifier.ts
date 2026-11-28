import type { EvidenceContext } from "./quorum";
import { aggregate, blindMatch, citationKey, evidenceLevel } from "./quorum";
import type {
  Gateway,
  Guidance,
  Hypothesis,
  ModelRequest,
  ArtifactRef,
  Profile,
  Snapshot,
  Vote,
} from "./types";
import { readerOf, type SnapshotReader } from "./snapshot";
import { DEFAULT_VERIFY_TOKENS } from "./budget";
import type { Ledger } from "./gateway";
import {
  Refused,
  VOTE_SCHEMA,
  converse,
  fits,
  retryAfterMs,
  systemPrompt,
  tokenBound,
} from "./gateway";
import { blindPrompt, join, parts, partitionElement } from "./prompt";
import {
  dataBlock,
  filteredLines,
  guidanceBlock,
  readFile,
  Tools,
} from "./tools";
import { validateAnswer, validateHypotheses } from "./validation";
import type { Verified } from "./consolidate";
export type FailureKind = "permanent" | "prolonged_outage" | "transient";

export function classifyVerifierFailure(
  message: string,
  remainingMs = Infinity,
): FailureKind | null {
  if (
    /provider failed \((400\s+(?:model_not_found|unknown_model|invalid_model|permission_error)|401|402|403|404)\b/i.test(
      message,
    ) ||
    /model_not_found|unknown model|no default model/i.test(message)
  )
    return "permanent";
  if (/provider failed \(429\)/i.test(message)) {
    const after = retryAfterMs(message);
    if (
      after > 300_000 ||
      (Number.isFinite(remainingMs) && after > remainingMs)
    )
      return "prolonged_outage";
    return "transient";
  }
  if (
    /provider failed \(5\d\d\)/i.test(message) ||
    /omitted content or usage|timeout/i.test(message)
  )
    return "transient";
  return null;
}

/**
 * Per-review verifier circuit breaker: trips immediately on permanent model
 * errors or >5m rate limits, or after 3 consecutive transient failures,
 * failing over to an optional fallback model or aborting remaining votes.
 */
export class VerifierBreaker {
  private primaryTripped = false;
  private fallbackTripped = false;
  private consecutive = new Map<string, number>();
  private _fallbackEvent?: { from: string; to: string; reason: string };
  private _abortReason?: string;

  constructor(
    readonly primary: string,
    readonly fallback?: string,
  ) {}

  activeModel(): { model: string; usingFallback: boolean } | null {
    if (!this.primaryTripped)
      return { model: this.primary, usingFallback: false };
    if (this.fallback && !this.fallbackTripped)
      return { model: this.fallback, usingFallback: true };
    return null;
  }

  get abortedReason(): string | undefined {
    return this._abortReason;
  }

  get fallbackUsed(): { from: string; to: string; reason: string } | undefined {
    return this._fallbackEvent;
  }

  canFallback(): boolean {
    return (
      !!this.fallback && this.fallback !== this.primary && !this.fallbackTripped
    );
  }

  recordSuccess(model: string) {
    this.consecutive.set(model, 0);
  }

  recordFailure(model: string, error: string, remainingMs = Infinity): boolean {
    const kind = classifyVerifierFailure(error, remainingMs);
    if (!kind) return false;
    // Concurrent in-flight primary voters that fail after another voter already
    // tripped primary should still retry on the active fallback.
    if (model === this.primary && this.primaryTripped) {
      return this.canFallback();
    }
    const count =
      kind === "permanent" || kind === "prolonged_outage"
        ? 3
        : (this.consecutive.get(model) ?? 0) + 1;
    this.consecutive.set(model, count);
    if (count < 3) return false;
    const cleanReason = error.replace(/\s+/g, " ").trim().slice(0, 120);
    if (model === this.primary && !this.primaryTripped) {
      this.primaryTripped = true;
      if (this.canFallback()) {
        this._fallbackEvent = {
          from: this.primary,
          to: this.fallback!,
          reason: cleanReason || kind,
        };
        return true;
      }
      this._abortReason = `circuit_open: ${cleanReason || kind}`;
      return false;
    }
    if (model === this.fallback && !this.fallbackTripped) {
      this.fallbackTripped = true;
      if (this.primaryTripped) {
        this._abortReason = `circuit_open: fallback failed (${cleanReason || kind})`;
      }
    }
    return false;
  }
}

export interface VerifyOptions {
  profile: Profile;
  hypothesis: Hypothesis;
  intent: string;
  guidance: Guidance[];
  snapshot: Snapshot | SnapshotReader;
  context: EvidenceContext;
  gateway: Gateway;
  ledger: Ledger;
  tools: (voter: number) => Tools;
  verifyTokens?: number;
  cancelled?: () => Promise<boolean>;
  call?: Parameters<typeof converse>[0]["call"];
  record?: Parameters<typeof converse>[0]["record"];
  save: (vote: Vote) => Promise<void>;
  breaker?: VerifierBreaker;
  partitionFor?: (model: string) => string;
  // Prompt settings (design D4, D9, D12, D14); absent means the pre-change layout.
  prompt?: {
    partition?: string;
    // `verifier-system`: one system prompt; the vote schema with the disclosure.
    single?: boolean;
    compaction?: boolean;
    cache?: { classes: string[]; key?: string };
  };
}
/** The evidence context with head modes and verified non-AST citations filled in. */
async function cited(
  o: VerifyOptions,
  refs: ArtifactRef[],
): Promise<EvidenceContext> {
  const head = { ...o.context.snapshot.head };
  const verifiedCitations = new Set(o.context.verifiedCitations ?? []);
  const reader = readerOf(o.snapshot);
  const tree = reader.head;
  for (const ref of refs) {
    if (ref.path && !Object.hasOwn(head, ref.path)) {
      const entry = await tree.stat(ref.path);
      if (entry) head[ref.path] = { mode: entry.mode };
    }
    if (
      ref.kind === "file_citation" &&
      ref.version === "head" &&
      ref.path &&
      head[ref.path] &&
      head[ref.path].mode !== 0o120000 &&
      Number.isInteger(ref.line_start) &&
      Number.isInteger(ref.line_end) &&
      ref.line_start! >= 1 &&
      ref.line_end! >= ref.line_start! &&
      ref.excerpt?.trim()
    ) {
      try {
        const lines = (await readFile(reader, ref.path, "head")).split("\n");
        if (ref.line_end! <= lines.length) {
          const slice = lines
            .slice(ref.line_start! - 1, ref.line_end!)
            .join("\n")
            .replace(/\s+/g, " ")
            .trim();
          const excerpt = ref.excerpt.replace(/\s+/g, " ").trim();
          if (excerpt && slice.includes(excerpt))
            verifiedCitations.add(citationKey(ref));
        }
      } catch {
        /* Leave unverified when the head file cannot be read cleanly. */
      }
    }
  }
  return { ...o.context, snapshot: { head }, verifiedCitations };
}
/** Contract hypotheses are settled through graph paths in both versions. */
export const CONTRACT_VERIFICATION =
  " This is a contract hypothesis: static_proven requires one code citation whose head graph node_ids form a connected path, possibly across files, from a cited consumer location to the changed contract's file. If head updated a cited consumer so it no longer relies on the old contract, answer refuted and cite that consumer's head graph node as a code reference with demonstrates protection; a protection on that path also refutes it.";
/** Code bytes per version in a voter's blind context; read_file covers the rest. */
export const CONTEXT_BYTES = 24 * 1024;
/** Lines of one symbol excerpted before the voter must read the file itself. */
export const SYMBOL_LINES = 300;
/** Turn cap for the blind verification phase when `blind_mode` is `"defects_only"`. */
export const BLIND_TURNS = 4;
/** A voter's blind message: the question, then the blind context. */
export async function blindContext(o: VerifyOptions): Promise<string> {
  return join(blindPrompt(await blindBlocks(o)));
}
/**
 * The blind context: location, selected code and direct callers, intent and
 * scoped guidance. Only the location is copied from the hypothesis.
 */
export async function blindBlocks(o: VerifyOptions): Promise<string> {
  const location = o.hypothesis.location;
  const reader = readerOf(o.snapshot);
  const versions = await Promise.all(
    ["base", "head"].map(async (version) => {
      const graph =
        version === "head" ? o.context.head : o.tools(0).graphs.base;
      const symbol = graph.nodes.find(
        (n) =>
          n.path === location.path && n.symbol_path === location.symbol_path,
      );
      const callers = symbol
        ? graph.edges
            .filter((e) => e.to === symbol.id)
            .map((e) => graph.nodes.find((n) => n.id === e.from))
            .filter(Boolean)
        : [];
      const nodes = [...(symbol ? [symbol] : []), ...callers].slice(0, 20);
      const v = version as "base" | "head";
      const symbols = [];
      // Voter conversations are bounded by bytes; a declaration file or a symbol
      // spanning hundreds of lines must not fill the allowance on the first turn.
      let remaining = CONTEXT_BYTES;
      let omitted = 0;
      for (const n of nodes) {
        if (remaining <= 0) {
          omitted++;
          continue;
        }
        const lines = (await readFile(reader, n!.path, v))
          .split("\n")
          .slice(n!.line_start - 1, n!.line_end);
        let content = lines.slice(0, SYMBOL_LINES).join("\n");
        const truncated =
          lines.length > SYMBOL_LINES || content.length > remaining;
        content = content.slice(0, Math.max(0, remaining));
        remaining -= content.length;
        symbols.push({
          node: n,
          content,
          ...(truncated ? { truncated: true } : {}),
        });
      }
      // A file added (or deleted) by the change has no counterpart to excerpt;
      // the location's surroundings are bounded like a symbol excerpt.
      let fallback: string | null | undefined;
      let fallbackTruncated = false;
      if (!nodes.length && (await reader[v].stat(location.path))) {
        const start = Math.max(0, location.line_start - 20);
        const window = (await readFile(reader, location.path, v))
          .split("\n")
          .slice(start, location.line_end + 20);
        const text = window.slice(0, SYMBOL_LINES).join("\n");
        fallback = text.slice(0, CONTEXT_BYTES);
        fallbackTruncated =
          window.length > SYMBOL_LINES || text.length > CONTEXT_BYTES;
      } else if (!nodes.length) fallback = null;
      return {
        version,
        symbols,
        ...(omitted ? { callers_omitted: omitted } : {}),
        fallback,
        ...(fallbackTruncated ? { fallback_truncated: true } : {}),
      };
    }),
  );
  // Only location is copied; no title, trigger, proposed impact, rationale, or id.
  return `${dataBlock("location", { path: location.path, symbol_path: location.symbol_path })}\n${dataBlock("selected code and direct callers", versions)}\n${dataBlock("intent", filteredLines(o.intent.split("\n")))}\n${guidanceBlock(o.guidance, [location.path])}`;
}
/**
 * The voters and quorum of one hypothesis. A hypothesis its agent classed as a
 * risk is never reported as a defect, whatever its voters find, so a profile
 * may have fewer of them examine it (`verify.risk_voters`).
 */
export function panelOf(
  verify: Profile["verify"],
  hypothesis: Pick<Hypothesis, "category">,
): { voters: number; quorum: number } {
  const voters =
    hypothesis.category === "risk"
      ? Math.min(verify.risk_voters ?? verify.voters, verify.voters)
      : verify.voters;
  return { voters, quorum: Math.min(verify.quorum, voters) };
}
/** A disclosed answer within the vote schema whose reclassification, if any, is downward. */
function acceptAnswer(value: any, hypothesis: Hypothesis) {
  const answer = validateAnswer(value);
  if (answer.category && answer.category !== hypothesis.category) {
    const downward: Record<string, number> = {
      security: 4,
      defect: 4,
      risk: 3,
      diagnostic: 2,
      style: 1,
    };
    if (
      !answer.reclassification_reason ||
      downward[answer.category] >= downward[hypothesis.category]
    )
      throw new Error("invalid downward reclassification");
  }
  return answer;
}
/**
 * Whether the votes cast so far already fix the outcome: a quorum of them, all
 * completed, at one validated level and with one category. Aggregation needs
 * `quorum` votes at a level to raise or refute it and `quorum` votes for a
 * reclassification, so fewer remaining voters than that change neither: with a
 * 2-of-3 panel, the third vote.
 */
export function settledBy(
  votes: Vote[],
  voters: number,
  quorum: number,
  hypothesis: Pick<Hypothesis, "category">,
): boolean {
  // Enough voters left to form a quorum of their own could still overturn it.
  if (votes.length < quorum || voters - votes.length >= quorum) return false;
  const category = (v: Vote) => v.answer?.category ?? hypothesis.category;
  return votes.every(
    (v) =>
      v.status === "completed" &&
      v.validated_level !== undefined &&
      v.validated_level === votes[0].validated_level &&
      category(v) === category(votes[0]),
  );
}
export async function verifyHypothesis(
  o: VerifyOptions,
): Promise<{ verified: Verified; votes: Vote[] }> {
  const { voters, quorum } = panelOf(o.profile.verify, o.hypothesis);
  const blindMode = o.profile.verify.blind_mode ?? "defects_only";
  const skipBlind =
    blindMode === "off" ||
    (blindMode === "defects_only" &&
      (o.hypothesis.category === "risk" || voters === 1));
  const blindLimited = !skipBlind && blindMode === "defects_only";
  const alias =
    o.profile.verify.model ??
    (o.profile.models.verifier ? "verifier" : "default");
  const votes: Vote[] = [];
  // The first `quorum` voters run alone. When they all complete and agree, on
  // the level and on the category, no later vote can change either, so the
  // remaining voters are not asked. Bounded fan-out still creates isolated
  // conversations, tools and token allowances.
  const wave = (offset: number) =>
    Math.min(offset + 4, offset < quorum ? quorum : voters);
  for (
    let offset = 0;
    offset < voters &&
    !(offset >= quorum && settledBy(votes, voters, quorum, o.hypothesis));
    offset = wave(offset)
  )
    await Promise.all(
      Array.from({ length: wave(offset) - offset }, async (_, index) => {
        const voter = offset + index,
          vote: Vote = {
            voter,
            status: "failed",
            blind: [],
            blind_match: "none",
          };
        let voterAttempt = 0;
        let retryFallback = false;
        while (true) {
          const active = o.breaker
            ? retryFallback && o.breaker.canFallback()
              ? { model: o.breaker.fallback!, usingFallback: true }
              : o.breaker.activeModel()
            : { model: o.profile.models[alias], usingFallback: false };
          if (!active) {
            vote.status = "failed";
            vote.error = o.breaker?.abortedReason ?? "circuit_open";
            break;
          }
          vote.blind = [];
          vote.blind_match = "none";
          delete vote.answer;
          delete vote.validated_level;
          delete vote.validation_note;
          delete vote.error;
          const partition =
            active.usingFallback && o.partitionFor
              ? o.partitionFor(active.model)
              : o.prompt?.partition;
          try {
            const allowance = {
              remaining: o.verifyTokens ?? DEFAULT_VERIFY_TOKENS,
            };
            const blocks = await blindBlocks(o);
            const tools = o.tools(voter);
            const messages: ModelRequest["messages"] = [];
            const options = {
              gateway: o.gateway,
              ledger: o.ledger,
              actor: active.usingFallback
                ? `${o.hypothesis.id}-${voter}-fb`
                : `${o.hypothesis.id}-${voter}`,
              model: active.model,
              allowance,
              messages,
              dispatch: tools.dispatch.bind(tools),
              call: o.call,
              record: o.record,
              cancelled: o.cancelled,
              singleSystem: o.prompt?.single,
              compaction: o.prompt?.compaction,
              ...(o.prompt?.cache ? { cache: o.prompt.cache } : {}),
              ...(partition ? { redact: [partition] } : {}),
            };
            const disclosure = (single: boolean) => ({
              role: "user" as const,
              content: `Verify this hypothesis. Assess regression on base/head, reachability, protections and contracts. Return {result:{evidence_level,evidence:[{kind:execution|code|file_citation,version:base|head,job_id?,path?,node_ids?,line_start?,line_end?,excerpt?,demonstrates:regression|protection}],category?,reclassification_reason?}}. Reproduced requires a failed head runner execution of the reproduction; refutation requires a passing head reproduction or a cited protection. Static proof must cite the actual head graph path (or for a non-AST file with no graph nodes, cite file_citation with line_start, line_end, and verbatim excerpt from head). Keep the original category by omitting category. Only downward changes are permitted: defect/security to risk/diagnostic/style, risk to diagnostic/style, diagnostic to style, with reclassification_reason required. Diagnostic is only a restatement of a diagnostic the deterministic checks reported, and style only a preference of layout or taste: a wrong message, a misspelling, unused or repeated code and a misleading name are neither, and hypotheses of either category are not reported. Never upgrade risk to defect, even if proven; category and evidence level are independent. Cite only job IDs returned by an actual host run tool. If you have not executed a reproduction, use static_proven with actual head graph node IDs (or file_citation on non-AST files) or plausible; describing a command does not execute it.${o.hypothesis.rule_id.startsWith("contracts/") ? CONTRACT_VERIFICATION : ""}\n${single ? `${VOTE_SCHEMA}\n` : ""}${dataBlock("hypothesis", o.hypothesis)}`,
            });
            if (!skipBlind) {
              messages.push({
                role: "user",
                content: blindPrompt(blocks, partition),
              });
              const blindDispatch = blindLimited
                ? async (name: string, input: any) => {
                    if (name === "run")
                      throw new Error(
                        "run is disabled during blind verification; inspect code with read_file, search, list_files, file_stat, or graph_query",
                      );
                    return tools.dispatch(name, input);
                  }
                : options.dispatch;
              try {
                const blind = await converse({
                  ...options,
                  dispatch: blindDispatch,
                  ...(blindLimited ? { maxTurns: BLIND_TURNS } : {}),
                  phase: "verify-blind",
                  // A restated hypothesis outside the schema, such as one with a
                  // field it does not name, is sent back with the reason instead
                  // of failing the vote.
                  validateResult: (value) => {
                    try {
                      return validateHypotheses(value);
                    } catch (error) {
                      const reason =
                        error instanceof Error ? error.message : "";
                      throw new Refused(
                        reason,
                        `Host: your result was not accepted: ${reason.slice(0, 300)}. Reply with {"result":[...]} again, each hypothesis following the item schema exactly, with no fields it does not name.`,
                      );
                    }
                  },
                });
                vote.blind = validateHypotheses(blind);
                vote.blind_match = blindMatch(vote.blind, o.hypothesis);
                // Persist before disclosing the hypothesis; the audit distinguishes an unfinished second turn.
                await o.save(vote);
              } catch (blindError) {
                // Under defects_only, blind inspection is capped at BLIND_TURNS;
                // a voter that spent those turns reading code still proceeds to
                // the disclosed verdict instead of failing the vote as exhausted.
                if (
                  blindLimited &&
                  blindError instanceof Error &&
                  /turn limit exhausted/i.test(blindError.message)
                ) {
                  if (messages.at(-1)?.role === "user") {
                    messages.push({
                      role: "assistant",
                      content: JSON.stringify({ result: [] }),
                    });
                  }
                  vote.blind = [];
                  vote.blind_match = "none";
                  await o.save(vote);
                } else {
                  throw blindError;
                }
              }
            } else {
              vote.blind = [];
              vote.blind_match = "none";
            }
            const makeDisclosed = (
              single: boolean,
            ): ModelRequest["messages"][number] =>
              skipBlind
                ? {
                    role: "user",
                    content: partition
                      ? parts(
                          {
                            layer: "assignment",
                            text: `${disclosure(single).content}\n`,
                          },
                          {
                            layer: "partition",
                            text: `${partitionElement(partition)}\n`,
                          },
                          { layer: "context", text: blocks, cache: true },
                        )
                      : `${disclosure(single).content}\n\n${blocks}`,
                  }
                : disclosure(single);
            // `verifier-system` keeps the blind system prompt only while the
            // disclosed turn, which then also carries the hypothesis schema, fits
            // the voter's allowance; otherwise the voter falls back to the
            // separate disclosed prompt rather than exhausting (design D4).
            let single = !!o.prompt?.single;
            if (single)
              single = fits(
                Math.min(allowance.remaining, await o.ledger.remaining()),
                tokenBound(systemPrompt("verify-disclosed", true), [
                  ...messages,
                  makeDisclosed(true),
                ]),
              );
            messages.push(makeDisclosed(single));
            vote.answer = acceptAnswer(
              await converse({
                ...options,
                singleSystem: single,
                phase: "verify-disclosed",
                // A vote outside the schema, such as one with a `note` beside
                // its evidence, or a reclassification the rules do not permit,
                // is sent back with the reason instead of failing the vote.
                validateResult: (value) => {
                  try {
                    return acceptAnswer(value, o.hypothesis);
                  } catch (error) {
                    const reason = error instanceof Error ? error.message : "";
                    throw new Refused(
                      reason,
                      `Host: your result was not accepted: ${reason.slice(0, 300)}. Reply with {"result":{...}} again, following the vote schema exactly, with no fields it does not name.`,
                    );
                  }
                },
              }),
              o.hypothesis,
            );
            vote.validated_level = evidenceLevel(
              vote.answer,
              o.hypothesis,
              await cited(o, vote.answer.evidence),
            );
            if (vote.validated_level !== vote.answer.evidence_level)
              vote.validation_note =
                "Claimed evidence level is not supported by valid selected-review artifacts.";
            vote.status = "completed";
            o.breaker?.recordSuccess(active.model);
            break;
          } catch (error) {
            const msg = error instanceof Error ? error.message : "voter failed";
            const remainingMs = await o.ledger
              .remainingMs?.()
              .catch(() => Infinity);
            if (o.breaker) {
              const switched = o.breaker.recordFailure(
                active.model,
                msg,
                remainingMs,
              );
              if (
                voterAttempt === 0 &&
                !active.usingFallback &&
                (switched ||
                  (classifyVerifierFailure(msg, remainingMs) !== null &&
                    o.breaker.canFallback()))
              ) {
                voterAttempt++;
                retryFallback = !switched;
                continue;
              }
            }
            vote.error = msg;
            vote.status = /cancel/.test(vote.error)
              ? "cancelled"
              : /budget|allowance|turn limit/.test(vote.error)
                ? "exhausted"
                : /malformed|invalid/.test(vote.error)
                  ? "malformed"
                  : "failed";
            break;
          }
        }
        await o.save(vote);
        votes.push(vote);
      }),
    );
  votes.sort((a, b) => a.voter - b.voter);
  const result = aggregate(votes, voters, quorum);
  const changes = votes.filter(
    (v) =>
      v.status === "completed" &&
      v.answer?.category &&
      v.answer.category !== o.hypothesis.category,
  );
  const counts = new Map<string, number>();
  for (const v of changes)
    counts.set(v.answer!.category!, (counts.get(v.answer!.category!) ?? 0) + 1);
  const category = [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .find(([, n]) => n >= quorum)?.[0] as Hypothesis["category"] | undefined;
  const context = await cited(
    o,
    votes.flatMap((v) =>
      v.status === "completed" && v.answer ? v.answer.evidence : [],
    ),
  );
  const evidence = [
    ...new Set(
      votes
        .filter((v) => v.status === "completed" && v.answer)
        .flatMap((v) =>
          v
            .answer!.evidence.filter(
              (ref) =>
                evidenceLevel(
                  { evidence_level: v.answer!.evidence_level, evidence: [ref] },
                  o.hypothesis,
                  context,
                ) !== "plausible",
            )
            .map((ref) =>
              ref.kind === "execution"
                ? `execution:${ref.version}:${ref.job_id}`
                : ref.kind === "file_citation"
                  ? `file_citation:${ref.version}:${ref.path}:${ref.line_start}-${ref.line_end}`
                  : `code:${ref.version}:${ref.path}:${(ref.node_ids ?? []).join(",")}`,
            ),
        ),
    ),
  ].sort();
  return {
    verified: {
      hypothesis: o.hypothesis,
      ...result,
      category,
      evidence,
      reclassification_reason: changes.find(
        (v) => v.answer?.category === category,
      )?.answer?.reclassification_reason,
    },
    votes,
  };
}
