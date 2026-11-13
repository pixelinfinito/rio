/**
 * The prompt builder (design D1): requests are built from ordered parts, each
 * tagged with its layer and, where a reread is expected, a cache breakpoint.
 * Parts carry their own separators, so joining their text gives exactly the
 * string a route without cache support receives.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export const sha256Hex = (value: string) =>
  bytesToHex(sha256(new TextEncoder().encode(value)));

export type Layer =
  | "system"
  | "instructions"
  | "partition"
  | "context"
  | "assignment"
  | "conversation";
export interface PromptPart {
  text: string;
  layer: Layer;
  // A cache breakpoint after this part, where the route supports one.
  cache?: true;
}
export type Content = string | PromptPart[];
export const LAYERS: Layer[] = [
  "system",
  "instructions",
  "partition",
  "context",
  "assignment",
  "conversation",
];

/** The text a content carries, cache markers and part boundaries removed. */
export function join(content: Content): string {
  return typeof content === "string"
    ? content
    : content.map((p) => p.text).join("");
}
/** Drops empty parts, so no route receives an empty text block. */
export function parts(...list: (PromptPart | false | undefined)[]): PromptPart[] {
  return list.filter((p): p is PromptPart => !!p && p.text.length > 0);
}

/**
 * Hash and byte length of each layer of a request, over the rendered text in
 * layer order; plain-string messages after the first are the conversation.
 * Records carry these, never the text.
 */
export function layerHashes(
  system: Content,
  messages: { content: Content }[],
): { layer: Layer; sha256: string; bytes: number }[] {
  const text = new Map<Layer, string>();
  const add = (layer: Layer, value: string) =>
    text.set(layer, (text.get(layer) ?? "") + value);
  const visit = (content: Content, fallback: Layer) => {
    if (typeof content === "string") add(fallback, content);
    else for (const p of content) add(p.layer, p.text);
  };
  visit(system, "system");
  messages.forEach((m, i) =>
    visit(m.content, i === 0 ? "context" : "conversation"),
  );
  return LAYERS.filter((l) => text.has(l)).map((layer) => ({
    layer,
    sha256: sha256Hex(text.get(layer)!),
    bytes: new TextEncoder().encode(text.get(layer)!).length,
  }));
}

/** The tenant partition element (design D14): data, not an instruction. */
export const partitionElement = (value: string) =>
  `<review_partition id="${value}"/>`;

/** Instructions every generation agent shares, whatever the agent. */
export const GENERATION_INSTRUCTIONS =
  "Inspect actual base and head code before making a claim; symbol names and graph hashes are not source code. The change diff holds the changed lines of each file with their head line numbers; an entry marked truncated, unshown or omitted holds more change than it shows, and read_file gives the rest. Suggested focus is only a hint; tools can read/search either entire repository snapshot. The graph excerpt holds the changed symbols and their nearest neighbours; query graph_query for anything beyond it. Category defect is behaviour that is wrong in head; risk is a hazard that is not settled, or an improvement that is not a wrong behaviour; diagnostic is only a restatement of a diagnostic in the checks block; style is only a preference of layout or taste. Diagnostic and style hypotheses are not reported. Omit guidance unless citing a real owner-guidance document supplied below; source-code lines are not owner guidance. Check guidance/contradiction and guidance/stale risks against existing guidance lines: emit category risk, cite guidance:{path,line} and the changed code behavior.";

/**
 * The second look: asked once after an agent's result, in the same conversation,
 * of agents whose manifest takes one. A first pass follows what stands out; this
 * turn is for what it read past.
 */
export const SECOND_LOOK =
  'That result is your first pass. A first pass follows the concerns that stand out and reads the rest of the change faster, so problems remain in the hunks it passed over and next to the ones it raised. Take a second look for those. Go through the change diff again, hunk by hunk, also where a hunk already carries a hypothesis, and check each against the list in your instructions as if nobody had reviewed it yet: inputs it does not handle, conditions, arguments and return values, error paths, the text of comments, messages and names, leftovers, and a fix made in one place and missing from its sibling. Read surrounding code with the tools where a concern needs it. Return {"result": [...]} holding hypotheses only for problems the first result does not hold, under the same rules; never a hypothesis of the first result again, in the same or in other words. An empty array is the right result when the second look finds nothing you would raise with the author.';

/** The rendered blocks of one agent's first generation message. */
export interface GenerationInputs {
  agent: string;
  // The agent's own instructions; empty for agents without them.
  instructions: string;
  // Lineage round context, starting with a newline, or empty.
  round: string;
  intent: string;
  focus: string;
  graph: string;
  changed: string;
  checks: string;
  // Agent data blocks (contract inventory, catalog and taint map), each
  // starting with a newline, or empty.
  data: string;
  guidance: string;
  partition?: string;
  // `agent-order`: shared instructions and review context before the assignment.
  order?: boolean;
}
/**
 * One agent's first generation message. Without `agent-order` it is the
 * pre-change text (agent name first), with the partition before the review
 * context. With it: shared instructions, partition, review context (cached),
 * then the assignment.
 */
export function generationPrompt(i: GenerationInputs): PromptPart[] {
  const shape = "Return {result:hypotheses[]}.";
  const partition = i.partition
    ? `\n${partitionElement(i.partition)}`
    : "";
  if (!i.order)
    return parts(
      {
        layer: "assignment",
        text: `Review the change independently for ${i.agent}. ${GENERATION_INSTRUCTIONS} ${i.instructions ? "" : shape}${i.instructions ? `\n${i.instructions}` : ""}`,
      },
      { layer: "partition", text: partition },
      {
        layer: "context",
        text: `${i.round}\n${i.intent}\n${i.focus}\n${i.graph}\n${i.changed}\n${i.checks}${i.data}\n${i.guidance}`,
        cache: true,
      },
    );
  return parts(
    { layer: "instructions", text: GENERATION_INSTRUCTIONS },
    { layer: "partition", text: partition },
    {
      layer: "context",
      text: `${i.round}\n${i.intent}\n${i.graph}\n${i.changed}\n${i.checks}\n${i.guidance}`,
      cache: true,
    },
    {
      layer: "assignment",
      text: `\nReview the change independently for ${i.agent}. ${i.instructions ? i.instructions : shape}\n${i.focus}${i.data}`,
    },
  );
}

/** The blind question every voter receives before its context. */
export const BLIND_INSTRUCTIONS =
  "What, if anything, is wrong in this function? Return {result: hypotheses[]}; [] is valid. Excerpts marked truncated and omitted callers are available through read_file and graph_query. ";
/** A voter's blind message: the question, the partition, then the blind context (cached). */
export function blindPrompt(context: string, partition?: string): PromptPart[] {
  return parts(
    { layer: "instructions", text: BLIND_INSTRUCTIONS },
    {
      layer: "partition",
      text: partition ? `${partitionElement(partition)}\n` : "",
    },
    { layer: "context", text: context, cache: true },
  );
}

/**
 * The council member's user content. Without `council-order` it is the
 * pre-change order (round header, then rendering) after the partition; with
 * it, the rendering (cached) comes first, so round 2 extends round 1's prefix.
 */
export function councilContent(
  header: string,
  rendering: string,
  rest: string[],
  partition?: string,
  order?: boolean,
): PromptPart[] {
  const element = partition ? `${partitionElement(partition)}\n` : "";
  if (!order)
    return parts(
      { layer: "partition", text: element },
      { layer: "context", text: [header, rendering].join("\n") },
      {
        layer: "assignment",
        text: rest.length ? `\n${rest.join("\n")}` : "",
      },
    );
  return parts(
    { layer: "partition", text: element },
    { layer: "context", text: rendering, cache: true },
    { layer: "assignment", text: `\n${[header, ...rest].join("\n")}` },
  );
}

/**
 * Replaces every partition value in text a model wrote, also where any of its
 * characters is written as a JSON `\uXXXX` escape that parsing would decode.
 */
export function redactPartitions(text: string, values: string[]): string {
  let out = text;
  for (const v of values) {
    if (!v) continue;
    const pattern = [...v]
      .map((c) => {
        const code = c.charCodeAt(0).toString(16).padStart(4, "0");
        const literal = c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const escape = [...code]
          .map((d) => (/[a-f]/.test(d) ? `[${d}${d.toUpperCase()}]` : d))
          .join("");
        return `(?:${literal}|\\\\u${escape})`;
      })
      .join("");
    out = out.replace(new RegExp(pattern, "g"), "[partition]");
  }
  return out;
}
