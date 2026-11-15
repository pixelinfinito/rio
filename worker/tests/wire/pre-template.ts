/**
 * The generation prompt template at the pinned baseline (2ac7b22), copied
 * verbatim from the agents step with its rendered blocks as inputs, and since
 * then following the shared instructions' wording. Tests use it as the frozen
 * reference the builder must reproduce with every feature off.
 */
import type { GenerationInputs } from "../../src/prompt";
export const preGenerationPrompt = (b: GenerationInputs) =>
  `Review the change independently for ${b.agent}. Inspect actual base and head code before making a claim; symbol names and graph hashes are not source code. The change diff holds the changed lines of each file with their head line numbers; an entry marked truncated, unshown or omitted holds more change than it shows, and read_file gives the rest. Suggested focus is only a hint; tools can read/search either entire repository snapshot. The graph excerpt holds the changed symbols and their nearest neighbours; query graph_query for anything beyond it. Category defect is behaviour that is wrong in head; risk is a hazard that is not settled, or an improvement that is not a wrong behaviour; diagnostic is only a restatement of a diagnostic in the checks block; style is only a preference of layout or taste. Diagnostic and style hypotheses are not reported. Omit guidance unless citing a real owner-guidance document supplied below; source-code lines are not owner guidance. Check guidance/contradiction and guidance/stale risks against existing guidance lines: emit category risk, cite guidance:{path,line} and the changed code behavior. ${b.instructions ? "" : "Return {result:hypotheses[]}."}${b.instructions ? `\n${b.instructions}` : ""}${b.round}\n${b.intent}\n${b.focus}\n${b.graph}\n${b.changed}\n${b.checks}${b.data}\n${b.guidance}`;
