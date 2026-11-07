import catalog from "./secret-patterns.json";
export function redact(text: string): string {
  for (const pattern of catalog.patterns) {
    const insensitive = pattern.regex.startsWith("(?i)");
    const expression = insensitive ? pattern.regex.slice(4) : pattern.regex;
    text = text.replace(
      new RegExp(expression, insensitive ? "gi" : "g"),
      (match) => `${match.slice(0, 4)}[REDACTED]`,
    );
  }
  // Credential-like assignments use the same entropy threshold as deterministic scanning.
  return text.replace(
    /((?:secret|token|password|passwd|api[_-]?key|private[_-]?key)[\w-]*[\s"']*[:=][\s"']*)([A-Za-z0-9_+\/-]{20,})/gi,
    (_, prefix: string, value: string) => {
      const counts = new Map<string, number>();
      for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
      const entropy = -[...counts.values()].reduce(
        (n, c) => n + (c / value.length) * Math.log2(c / value.length),
        0,
      );
      return (
        prefix +
        (entropy >= catalog.entropy.threshold
          ? `${value.slice(0, 4)}[REDACTED]`
          : value)
      );
    },
  );
}
export function scrub<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map(scrub) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, scrub(v)]),
    ) as T;
  return value;
}
