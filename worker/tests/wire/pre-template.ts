/**
 * The generation prompt template at the pinned baseline (2ac7b22), copied
 * verbatim from the agents step with its rendered blocks as inputs. Tests use it
 * as the frozen reference the builder must reproduce with every feature off.
 */
import type { GenerationInputs } from "../../src/prompt";
export const preGenerationPrompt = (b: GenerationInputs) =>
  `Review the change independently for ${b.agent}. Inspect actual base and head code before making a claim; symbol names and graph hashes are not source code. Use read_file for omitted or truncated code. Suggested focus is only a hint; tools can read/search either entire repository snapshot. The graph excerpt holds the changed symbols and their nearest neighbours; query graph_query for anything beyond it. Classify concrete correctness regressions as defect, uncertain hazards as risk, style and repeated tool diagnostics accurately. Omit guidance unless citing a real owner-guidance document supplied below; source-code lines are not owner guidance. Check guidance/contradiction and guidance/stale risks against existing guidance lines: emit category risk, cite guidance:{path,line} and the changed code behavior. ${b.instructions ? "" : "Return {result:hypotheses[]}."}${b.instructions ? `\n${b.instructions}` : ""}${b.round}\n${b.intent}\n${b.focus}\n${b.graph}\n${b.changed}\n${b.checks}${b.data}\n${b.guidance}`;
