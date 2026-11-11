// GitHub rejects a comment body over 65,536 characters (pr-comment-format
// "Comment size limits"). Folded sections give way first, then the visible
// text is cut; the hidden marker always survives as the last line.

export const COMMENT_LIMIT = 65_536;
export const MAX_FINDING_ROWS = 25;
export const MAX_JOURNEYS = 10;
const FOLDED =
  "Truncated to fit GitHub's comment size; the full report has every detail.";

/** `lines` plus the marker, under the limit. */
export function fitBody(
  lines: string[],
  marker: string,
  limit = COMMENT_LIMIT,
): string {
  const size = (body: string[]) => body.join("\n").length + 1 + marker.length;
  let body = [...lines];
  // Empty folded sections, last first, keeping their summaries.
  const folds: [number, number][] = [];
  for (let i = 0, start = -1; i < body.length; i++) {
    if (body[i].startsWith("<details")) start = i;
    else if (body[i] === "</details>" && start >= 0) {
      folds.push([start, i]);
      start = -1;
    }
  }
  for (const [start, end] of folds.reverse()) {
    if (size(body) <= limit) break;
    if (end - start > 2)
      body = [...body.slice(0, start + 1), "", FOLDED, ...body.slice(end)];
  }
  if (size(body) > limit) {
    // Keep the last line (the footer) and cut the rest at a line boundary.
    const last = body[body.length - 1];
    const note =
      "…truncated to fit GitHub's comment size; see the full report.";
    const room = limit - marker.length - last.length - note.length - 4;
    let text = body.slice(0, -1).join("\n").slice(0, Math.max(0, room));
    text = text.slice(0, Math.max(0, text.lastIndexOf("\n")));
    // Never leave a fence or a fold open.
    const fences = (text.match(/^`{3,}/gm) ?? []).length;
    const opened =
      (text.match(/^<details/gm) ?? []).length -
      (text.match(/^<\/details>/gm) ?? []).length;
    body = [
      text,
      ...(fences % 2 ? ["```"] : []),
      ...Array(Math.max(0, opened)).fill("</details>"),
      note,
      last,
    ];
  }
  return `${body.join("\n")}\n${marker}`;
}
