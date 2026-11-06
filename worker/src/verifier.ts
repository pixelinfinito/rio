import type { EvidenceContext } from "./quorum";
import { aggregate, blindMatch, evidenceLevel } from "./quorum";
import type {
  Gateway,
  Guidance,
  Hypothesis,
  ModelRequest,
  Profile,
  Snapshot,
  Vote,
} from "./types";
import type { Ledger } from "./gateway";
import { converse } from "./gateway";
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
  snapshot: Snapshot;
  context: EvidenceContext;
  gateway: Gateway;
  ledger: Ledger;
  tools: (voter: number) => Tools;
  agentTokens: number;
  verifyTokens?: number;
  cancelled?: () => Promise<boolean>;
  call?: Parameters<typeof converse>[0]["call"];
  save: (vote: Vote) => Promise<void>;
}
export function blindContext(o: VerifyOptions): string {
  const location = o.hypothesis.location;
  const versions = ["base", "head"].map((version) => {
    const graph = version === "head" ? o.context.head : o.tools(0).graphs.base;
    const symbol = graph.nodes.find(
      (n) => n.path === location.path && n.symbol_path === location.symbol_path,
    );
    const callers = symbol
      ? graph.edges
          .filter((e) => e.to === symbol.id)
          .map((e) => graph.nodes.find((n) => n.id === e.from))
          .filter(Boolean)
      : [];
    const nodes = [...(symbol ? [symbol] : []), ...callers].slice(0, 20);
    return {
      version,
      symbols: nodes.map((n) => ({
        node: n,
        content: readFile(o.snapshot, n!.path, version as "base" | "head")
          .split("\n")
          .slice(n!.line_start - 1, n!.line_end)
          .join("\n"),
      })),
      fallback: nodes.length
        ? undefined
        : readFile(o.snapshot, location.path, version as "base" | "head")
            .split("\n")
            .slice(
              Math.max(0, location.line_start - 20),
              location.line_end + 20,
            )
            .join("\n"),
    };
  });
  // Only location is copied; no title, trigger, proposed impact, rationale, or id.
  return `What, if anything, is wrong in this function? Return {result: hypotheses[]}; [] is valid. ${dataBlock("location", { path: location.path, symbol_path: location.symbol_path })}\n${dataBlock("selected code and direct callers", versions)}\n${dataBlock("intent", filteredLines(o.intent.split("\n")))}\n${guidanceBlock(o.guidance, [location.path])}`;
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
            remaining:
              o.verifyTokens ?? Math.max(1, Math.floor(o.agentTokens / 5)),
          };
          const messages: ModelRequest["messages"] = [
            { role: "user", content: blindContext(o) },
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
            cancelled: o.cancelled,
          };
          const blind = await converse({ ...options, phase: "verify-blind" });
          vote.blind = validateHypotheses(blind);
          vote.blind_match = blindMatch(vote.blind, o.hypothesis);
          // Persist before disclosing the hypothesis; the audit distinguishes an unfinished second turn.
          await o.save(vote);
          messages.push({
            role: "user",
            content: `Verify this hypothesis. Assess regression on base/head, reachability, protections and contracts. Return {result:{evidence_level,evidence:[{kind:execution|code,version:base|head,job_id?,path?,node_ids?,demonstrates:regression|protection}],category?,reclassification_reason?}}. Reproduced requires a failed head runner execution of the reproduction; refutation requires a passing head reproduction or a cited protection. Static proof must cite the actual head graph path. Keep the original category by omitting category. Only downward changes are permitted: defect/security to risk/diagnostic/style, risk to diagnostic/style, diagnostic to style, with reclassification_reason required. Never upgrade risk to defect, even if proven; category and evidence level are independent. Cite only job IDs returned by an actual host run tool. If you have not executed a reproduction, use static_proven with actual head graph node IDs or plausible; describing a command does not execute it.\n${dataBlock("hypothesis", o.hypothesis)}`,
          });
          vote.answer = validateAnswer(
            await converse({ ...options, phase: "verify-disclosed" }),
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
            o.context,
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
                  o.context,
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
