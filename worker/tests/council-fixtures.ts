import type { Verified } from "../src/consolidate";
import type { ExecutionResult, Graph, Hypothesis, Vote } from "../src/types";
import type { PackInput } from "../src/council-pack";

export const hypothesis: Hypothesis = {
  id: "h".repeat(64),
  rule_id: "security/missing-authorization",
  category: "security",
  severity: "error",
  location: {
    path: "src/auth.ts",
    line_start: 3,
    line_end: 5,
    symbol_path: "check",
    occurrence_state: "new",
  },
  message: "check() no longer verifies the session owner",
  trigger: "a request for another account's document",
  impact: "AGENT REASONING: the owner check was dropped, so anyone can read",
  suggested_fix: "restore the owner comparison",
  state: "new",
  source: { agent: "security" },
  limitations: ["AGENT LIMITATION"],
} as Hypothesis;

const node = (
  id: string,
  path: string,
  symbol: string,
  start: number,
  end: number,
) => ({
  id,
  path,
  symbol_path: symbol,
  line_start: start,
  line_end: end,
});
export const graphs: { base: Graph; head: Graph } = {
  base: {
    nodes: [
      node("b1", "src/auth.ts", "check", 3, 6),
      node("b2", "src/routes.ts", "get", 1, 4),
    ],
    edges: [{ from: "b2", to: "b1", kind: "calls" }],
  } as Graph,
  head: {
    nodes: [
      node("n1", "src/auth.ts", "check", 3, 5),
      node("n2", "src/routes.ts", "get", 1, 4),
      node("n3", "src/db.ts", "load", 1, 9),
      node("n4", "src/unrelated.ts", "far", 1, 2),
      node("n5", "src/other.ts", "middle", 1, 2),
    ],
    edges: [
      { from: "n2", to: "n1", kind: "calls" },
      { from: "n1", to: "n3", kind: "calls" },
      { from: "n4", to: "n5", kind: "calls" },
    ],
  } as Graph,
};
export const executions: Record<string, ExecutionResult> = {
  job1: {
    outcome: "exited",
    command: ["npm", "test", "--", "auth"],
    kind: "run",
    job_id: "job1",
    attempt: 1,
    exit_code: 1,
    stdout: "1 failing: owner check",
    stderr: "",
    timed_out: false,
    truncated: false,
    version: "head",
  },
};
export const votes: Vote[] = [0, 1, 2].map((voter) => ({
  voter,
  status: "completed",
  blind: [],
  blind_match: voter === 2 ? "none" : "same",
  answer: {
    evidence_level: "plausible",
    evidence: [
      {
        kind: "code",
        version: "head",
        path: "src/auth.ts",
        node_ids: ["n1"],
        demonstrates: "regression",
      },
      {
        kind: "execution",
        version: "head",
        job_id: "job1",
        demonstrates: "regression",
      },
    ],
  },
}));
export const verified: Verified = {
  hypothesis,
  evidence_level: "plausible",
  verification: {
    voters: 3,
    agreeing: 2,
    blind_match: ["same", "same", "none"],
    split: true,
  },
  evidence: [],
};
export const packInput: PackInput = {
  verified,
  finding: "f".repeat(64),
  votes,
  executions,
  graphs,
  hops: 1,
  files: {
    "src/auth.ts": {
      base: "export function check(user, doc) {\n  // owner\n  if (doc.owner !== user.id) throw new Error();\n  return doc;\n}\n",
      head: "export function check(user, doc) {\n  // owner\n  return doc;\n}\n",
    },
    "src/unrelated.ts": { base: "UNRELATED", head: "UNRELATED" },
  },
  intent: "Simplify the document route",
  guidance: [
    {
      path: "src/AGENTS.md",
      scope_dir: "src",
      content_hash: "x",
      lines: ["Owners only."],
    },
    {
      path: "lib/AGENTS.md",
      scope_dir: "lib",
      content_hash: "y",
      lines: ["Out of scope."],
    },
  ],
};
