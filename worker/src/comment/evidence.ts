import { plain } from "./text";

/** Only signed, unexpired report links enter publication. Transcript content
 * never belongs in a PR comment, even if a caller supplies a transcript id. */
export function qaEvidenceBody(
  qa: any,
  ids: string[] = [],
  images = false,
): string[] {
  const rows = (qa?.evidence?.artifacts ?? []).filter(
    (row: any) =>
      ids.includes(row.id) &&
      ["screenshot", "trace", "dom"].includes(row.kind) &&
      !row.expired &&
      !row.unavailable &&
      (!row.expires_at || row.expires_at > Date.now()) &&
      (!row.link_expires_at || row.link_expires_at > Date.now()),
  );
  const lines: string[] = [],
    expiries: number[] = [];
  for (const row of rows) {
    let url: URL;
    try {
      url = new URL(row.link);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || url.username || url.password) continue;
    const link = url.href.replace(/[<>\s]/g, (value) =>
      encodeURIComponent(value),
    );
    lines.push(
      `${images && row.kind === "screenshot" ? "!" : ""}[${row.kind}](<${link}>)`,
    );
    if (row.expires_at) expiries.push(row.expires_at);
    if (row.link_expires_at) expiries.push(row.link_expires_at);
  }
  if (lines.length)
    lines.push(
      `Evidence expires ${expiries.length ? new Date(Math.min(...expiries)).toISOString() : plain(qa?.evidence?.expires_at ?? "at the configured retention deadline")}. Copies cached by GitHub's image proxy may outlive this expiry.`,
    );
  return lines;
}
