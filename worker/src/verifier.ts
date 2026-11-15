import type { EvidenceContext } from "./quorum";
import { aggregate, blindMatch, evidenceLevel } from "./quorum";
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
  VOTE_SCHEMA,
  converse,
  fits,
  systemPrompt,
  tokenBound,
} from "./gateway";
import { blindPrompt, join } from "./prompt";
import {
  dataBlock,
  filteredLines,
  guidanceBlock,
  readFile,
  Tools,
} from "./tools";
import { validateAnswer, validateHypotheses } from "./validation";
import type { Verified } from "./consolidate";
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
  // Prompt settings (design D4, D9, D12, D14); absent means the pre-change layout.
  prompt?: {
    partition?: string;
    // `verifier-system`: one system prompt; the vote schema with the disclosure.
    single?: boolean;
    compaction?: boolean;
    cache?: { classes: string[]; key?: string };
  };
}
/** The evidence context with the head modes of every cited path filled in. */
async function cited(
  o: VerifyOptions,
  refs: ArtifactRef[],
): Promise<EvidenceContext> {
  const head = { ...o.context.snapshot.head };
  const tree = readerOf(o.snapshot).head;
  for (const ref of refs)
    if (ref.path && !Object.hasOwn(head, ref.path)) {
      const entry = await tree.stat(ref.path);
      if (entry) head[ref.path] = { mode: entry.mode };
    }
  return { ...o.context, snapshot: { head } };
}
/** Contract hypotheses are settled through graph paths in both versions. */
export const CONTRACT_VERIFICATION =
  " This is a contract hypothesis: static_proven requires one code citation whose head graph node_ids form a connected path, possibly across files, from a cited consumer location to the changed contract's file. If head updated a cited consumer so it no longer relies on the old contract, answer refuted and cite that consumer's head graph node as a code reference with demonstrates protection; a protection on that path also refutes it.";
/** Code bytes per version in a voter's blind context; read_file covers the rest. */
export const CONTEXT_BYTES = 24 * 1024;
/** Lines of one symbol excerpted before the voter must read the file itself. */
export const SYMBOL_LINES = 300;
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
export async function verifyHypothesis(
  o: VerifyOptions,
): Promise<{ verified: Verified; votes: Vote[] }> {
  const voters = o.profile.verify.voters,
    quorum = o.profile.verify.quorum;
  const alias =
    o.profile.verify.model ??
    (o.profile.models.verifier ? "verifier" : "default");
  const votes: Vote[] = [];
  // Bounded fan-out still creates isolated conversations, tools and token allowances.
  for (let offset = 0; offset < voters; offset += 4)
    await Promise.all(
      Array.from({ length: Math.min(4, voters - offset) }, async (_, index) => {
        const voter = offset + index,
          vote: Vote = {
            voter,
            status: "failed",
            blind: [],
            blind_match: "none",
          };
        try {
          const allowance = {
            remaining: o.verifyTokens ?? DEFAULT_VERIFY_TOKENS,
          };
          const messages: ModelRequest["messages"] = [
            {
              role: "user",
              content: blindPrompt(await blindBlocks(o), o.prompt?.partition),
            },
          ];
          const tools = o.tools(voter);
          const options = {
            gateway: o.gateway,
            ledger: o.ledger,
            actor: `${o.hypothesis.id}-${voter}`,
            model: o.profile.models[alias],
            allowance,
            messages,
            dispatch: tools.dispatch.bind(tools),
            call: o.call,
            record: o.record,
            cancelled: o.cancelled,
            singleSystem: o.prompt?.single,
            compaction: o.prompt?.compaction,
            ...(o.prompt?.cache ? { cache: o.prompt.cache } : {}),
            ...(o.prompt?.partition ? { redact: [o.prompt.partition] } : {}),
          };
          const blind = await converse({ ...options, phase: "verify-blind" });
          vote.blind = validateHypotheses(blind);
          vote.blind_match = blindMatch(vote.blind, o.hypothesis);
          // Persist before disclosing the hypothesis; the audit distinguishes an unfinished second turn.
          await o.save(vote);
          const disclosure = (single: boolean) => ({
            role: "user" as const,
            content: `Verify this hypothesis. Assess regression on base/head, reachability, protections and contracts. Return {result:{evidence_level,evidence:[{kind:execution|code,version:base|head,job_id?,path?,node_ids?,demonstrates:regression|protection}],category?,reclassification_reason?}}. Reproduced requires a failed head runner execution of the reproduction; refutation requires a passing head reproduction or a cited protection. Static proof must cite the actual head graph path. Keep the original category by omitting category. Only downward changes are permitted: defect/security to risk/diagnostic/style, risk to diagnostic/style, diagnostic to style, with reclassification_reason required. Never upgrade risk to defect, even if proven; category and evidence level are independent. Cite only job IDs returned by an actual host run tool. If you have not executed a reproduction, use static_proven with actual head graph node IDs or plausible; describing a command does not execute it.${o.hypothesis.rule_id.startsWith("contracts/") ? CONTRACT_VERIFICATION : ""}\n${single ? `${VOTE_SCHEMA}\n` : ""}${dataBlock("hypothesis", o.hypothesis)}`,
          });
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
                disclosure(true),
              ]),
            );
          messages.push(disclosure(single));
          vote.answer = validateAnswer(
            await converse({
              ...options,
              singleSystem: single,
              phase: "verify-disclosed",
            }),
          );
          if (
            vote.answer.category &&
            vote.answer.category !== o.hypothesis.category
          ) {
            const downward: Record<string, number> = {
              security: 4,
              defect: 4,
              risk: 3,
              diagnostic: 2,
              style: 1,
            };
            if (
              !vote.answer.reclassification_reason ||
              downward[vote.answer.category] >= downward[o.hypothesis.category]
            )
              throw new Error("invalid downward reclassification");
          }
          vote.validated_level = evidenceLevel(
            vote.answer,
            o.hypothesis,
            await cited(o, vote.answer.evidence),
          );
          if (vote.validated_level !== vote.answer.evidence_level)
            vote.validation_note =
              "Claimed evidence level is not supported by valid selected-review artifacts.";
          vote.status = "completed";
        } catch (error) {
          vote.error = error instanceof Error ? error.message : "voter failed";
          vote.status = /cancel/.test(vote.error)
            ? "cancelled"
            : /budget|allowance|turn limit/.test(vote.error)
              ? "exhausted"
              : /malformed|invalid/.test(vote.error)
                ? "malformed"
                : "failed";
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
                : `code:${ref.version}:${ref.path}:${ref.node_ids!.join(",")}`,
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
