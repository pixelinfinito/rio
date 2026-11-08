import picomatch from "picomatch";
import type { ChangedFile, Profile, Snapshot, Submission } from "./types";
import { invariant } from "./validation";
import { agents as manifests } from "./manifests";
import { contractSurface } from "./contracts";
export interface Risk {
  tier: "low" | "medium" | "high";
  reasons: string[];
  source: "triage" | "always_human";
}
export interface Plan {
  risk: Risk;
  require_human: boolean;
  mode: "fast" | "deep";
  agents: string[];
  /** Why each selected agent runs: `default`, a triage signal, or `rule: <when>`. */
  agent_reasons: Record<string, string>;
  suggested_focus: string[];
  signals: {
    adds_dependency: boolean;
    lines_changed: number;
    languages: string[];
  };
}
export function matches(glob: string, path: string): boolean {
  return picomatch(glob, { dot: true })(path);
}
function paths(changed: ChangedFile[]) {
  return changed.flatMap((f) => (f.old_path ? [f.path, f.old_path] : [f.path]));
}
function dependencies(content: string, path: string): Set<string> {
  if (path.endsWith("package.json")) {
    try {
      const value = JSON.parse(content);
      return new Set(
        [
          "dependencies",
          "devDependencies",
          "peerDependencies",
          "optionalDependencies",
        ].flatMap((key) => Object.keys(value[key] ?? {})),
      );
    } catch {
      return new Set();
    }
  }
  // Dependency names, rather than version lines, distinguish additions from updates.
  const names = new Set<string>();
  let section = "";
  for (const line of content.split("\n")) {
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) {
      section = header[1];
      continue;
    }
    const name = /^(?:\s*["']?)([A-Za-z0-9_.@/-]+)["']?\s*(?:=|[<>~!]=?)/.exec(
      line,
    );
    if (
      name &&
      (/dependenc/.test(section) || /requirements[^/]*\.txt$/.test(path))
    )
      names.add(name[1]);
  }
  return names;
}
export function triage(submission: Submission, snapshot: Snapshot): Plan {
  const p = submission.profile,
    opts = p.steps.find((s) => s.uses.startsWith("rio/triage@"))?.with ?? {};
  const changed = paths(submission.changed),
    reasons: string[] = [];
  let level = 0;
  const raise = (reason: string, severity: number) => {
    reasons.push(reason);
    level = Math.max(level, severity);
  };
  for (const glob of opts.sensitive_paths ?? [])
    if (changed.some((path) => matches(glob, path)))
      raise(`sensitive_path: ${glob}`, 2);
  let publicContract = false;
  if (
    opts.public_contracts !== false &&
    (changed.some(
      (path) =>
        matches("**/*.{proto,graphql,graphqls}", path) ||
        path.startsWith("schemas/") ||
        path.includes("/public/"),
    ) ||
      submission.changed.some(
        (file) =>
          JSON.stringify(
            contractSurface(
              file.old_path ?? file.path,
              snapshot.base[file.old_path ?? file.path]?.content ?? "",
            ),
          ) !==
          JSON.stringify(
            contractSurface(file.path, snapshot.head[file.path]?.content ?? ""),
          ),
      ))
  ) {
    raise("public_contract_change", 2);
    publicContract = true;
  }
  const depFiles = changed.filter((path) =>
    /(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.(?:lock|toml)|pyproject\.toml|requirements[^/]*\.txt|uv\.lock)$/.test(
      path,
    ),
  );
  const changedDependency = depFiles.some(
    (path) => snapshot.base[path]?.content !== snapshot.head[path]?.content,
  );
  const addsDependency = depFiles.some((path) => {
    const old = dependencies(snapshot.base[path]?.content ?? "", path);
    return [...dependencies(snapshot.head[path]?.content ?? "", path)].some(
      (name) => !old.has(name),
    );
  });
  if (opts.dependency_changes !== false && changedDependency)
    raise("dependency_change", 1);
  if (
    opts.missing_coverage !== false &&
    submission.report.risks.some((f: any) => f.rule_id?.startsWith("coverage/"))
  )
    raise("uncovered_changed_logic", 1);
  const fanout = Math.max(
    0,
    ...submission.report.impact.symbols.map((s: any) =>
      s.references_per_hop.reduce((a: number, b: number) => a + b, 0),
    ),
  );
  if (fanout >= (opts.fan_out_high ?? 20))
    raise(`fan_out: ${fanout} >= ${opts.fan_out_high ?? 20}`, 2);
  const overrides = (p.always_human ?? [])
    .filter((glob) => changed.some((path) => matches(glob, path)))
    .sort()
    .map((glob) => `always_human: ${glob}`);
  const risk: Risk = overrides.length
    ? {
        tier: "high",
        reasons: [...new Set([...reasons, ...overrides])].sort(),
        source: "always_human",
      }
    : {
        tier: (["low", "medium", "high"] as const)[level],
        reasons: reasons.sort(),
        source: "triage",
      };
  const extensions: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "typescript",
    jsx: "typescript",
    py: "python",
    rs: "rust",
  };
  const plan: Plan = {
    risk,
    require_human: !!overrides.length,
    mode: submission.mode,
    agents: ["correctness"],
    agent_reasons: { correctness: "default" },
    suggested_focus: submission.changed.map((f) => f.path),
    signals: {
      adds_dependency: addsDependency,
      lines_changed: submission.changed.reduce(
        (n, f) => n + (f.lines_changed ?? 0),
        0,
      ),
      languages: [
        ...new Set(
          changed
            .map((path) => extensions[path.split(".").at(-1) ?? ""])
            .filter(Boolean),
        ),
      ],
    },
  };
  // Agents whose manifest declares `contracts` review public-contract changes.
  if (publicContract)
    for (const [name, manifest] of Object.entries(manifests))
      if (
        manifest.contracts &&
        manifest.available &&
        !plan.agents.includes(name)
      ) {
        plan.agents.push(name);
        plan.agent_reasons[name] = "public_contract_change";
      }
  for (const step of p.steps)
    for (const rule of step.rules ?? [])
      if (evaluate(rule.when, plan, changed))
        applyAction(rule.then, plan, `rule: ${rule.when}`);
  invariant(
    !plan.agents.includes("verify") && !plan.agents.includes("verifier"),
    "verifier cannot be selected or disabled by triage",
  );
  if (overrides.length) plan.require_human = true;
  return plan;
}
// Recursive descent; no executable repository expressions.
export function evaluate(
  input: string,
  plan: Plan,
  changed: string[],
): boolean {
  const tokens =
    input.match(
      /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|>=|==|>|\(|\)|\d+|[A-Za-z_][\w/.-]*/g,
    ) ?? [];
  invariant(
    tokens.join("").replace(/\s/g, "") === input.replace(/\s/g, ""),
    "invalid rule token",
  );
  let at = 0;
  const take = () => {
    invariant(at < tokens.length, "unexpected end of rule");
    return tokens[at++];
  };
  const expect = (s: string) => invariant(take() === s, `expected ${s}`);
  const atom = () => {
    const value = take();
    return value.startsWith('"')
      ? JSON.parse(value)
      : value.startsWith("'")
        ? value.slice(1, -1).replace(/\\'/g, "'")
        : value;
  };
  function unary(): boolean {
    if (tokens[at] === "not") {
      at++;
      return !unary();
    }
    if (tokens[at] === "(") {
      at++;
      const value = or();
      expect(")");
      return value;
    }
    const name = take();
    if (name === "touches") {
      expect("(");
      const glob = atom();
      expect(")");
      return changed.some((path) => matches(glob, path));
    }
    if (name === "adds_dependency") {
      expect("(");
      expect(")");
      return plan.signals.adds_dependency;
    }
    if (name === "lines_changed") {
      expect(">");
      return plan.signals.lines_changed > Number(take());
    }
    if (name === "risk") {
      expect(">=");
      const level = atom();
      invariant(
        ["low", "medium", "high"].includes(level),
        "unknown risk level",
      );
      return (
        ["low", "medium", "high"].indexOf(plan.risk.tier) >=
        ["low", "medium", "high"].indexOf(level)
      );
    }
    if (name === "language") {
      expect("==");
      return plan.signals.languages.includes(atom());
    }
    throw new Error("unknown rule predicate");
  }
  function and(): boolean {
    let value = unary();
    while (tokens[at] === "and") {
      at++;
      const next = unary();
      value = value && next;
    }
    return value;
  }
  function or(): boolean {
    let value = and();
    while (tokens[at] === "or") {
      at++;
      const next = and();
      value = value || next;
    }
    return value;
  }
  const value = or();
  invariant(at === tokens.length, "trailing rule input");
  return value;
}
function applyAction(input: string, plan: Plan, reason: string) {
  const match =
    /^(enable|disable|budget|require_human)\(\s*([\w/.-]*|"[^"]*"|'[^']*')\s*\)$/.exec(
      input.trim(),
    );
  invariant(match, "invalid action");
  const arg = match[2].replace(/^["']|["']$/g, "");
  invariant(
    !["verify", "verifier", "rio/verify"].includes(arg),
    "triage cannot disable verification",
  );
  if (match[1] === "require_human") {
    plan.require_human = true;
    return;
  }
  if (match[1] === "budget") {
    invariant(arg === "fast" || arg === "deep", "unknown budget");
    plan.mode = arg;
    return;
  }
  invariant(
    ["correctness", "contracts", "tests", "performance", "security"].includes(
      arg,
    ),
    "unknown agent",
  );
  if (match[1] === "enable" && !plan.agents.includes(arg)) {
    plan.agents.push(arg);
    plan.agent_reasons[arg] = reason;
  } else if (match[1] === "enable") plan.agent_reasons[arg] = reason;
  if (match[1] === "disable") {
    plan.agents = plan.agents.filter((a) => a !== arg);
    delete plan.agent_reasons[arg];
  }
}
