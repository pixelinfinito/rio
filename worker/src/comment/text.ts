// Text helpers shared by every comment body. Repository text is data: it can
// never close a marker, mention a person or grow a comment without bound.

/** Repository text placed in a comment: no markers, no mentions, bounded. */
export function plain(text: string, max = 2000): string {
  const safe = text
    .replace(/<!--/g, "&lt;!--")
    .replace(/-->/g, "--&gt;")
    .replace(/@(?=[A-Za-z0-9])/g, "@​");
  if (safe.length <= max) return safe;
  // Cut at a word boundary and say so, never mid-word.
  const cut = safe.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}
/** A `path:line` code span. */
export function where(f: {
  location: { path: string; line_start: number };
}): string {
  return `\`${plain(f.location.path, 300)}:${f.location.line_start}\``;
}
/** Splits a message into its first sentence (the heading) and the rest. */
export function sentences(message: string): [string, string] {
  const first = message.split("\n")[0];
  const end = first.search(/[.!?](\s|$)/);
  if (end <= 20) return [first, message.slice(first.length).trim()];
  return [first.slice(0, end + 1), message.slice(end + 1).trim()];
}
/** The first sentence of a message, for headings and summary lines. */
export function headline(message: string, max = 160): string {
  return plain(sentences(message)[0], max);
}
/** Text for a GFM table cell. */
export function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
/** A fence one backtick longer than any backtick run in `text`. */
export function fence(text: string): string {
  const longest = Math.max(
    2,
    ...[...text.matchAll(/`+/g)].map((match) => match[0].length),
  );
  return "`".repeat(longest + 1);
}
/** Joins non-empty sentences into one paragraph, each ending with a stop. */
export function paragraph(parts: (string | undefined)[]): string {
  return parts
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .map((part) => (/[.!?:)`]$/.test(part) ? part : `${part}.`))
    .join(" ");
}
/** `1 m 02 s`, `14 s` or `850 ms`. */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} m ${String(seconds % 60).padStart(2, "0")} s`;
}
