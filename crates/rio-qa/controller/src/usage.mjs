/** Provider usage normalization shared by the Worker gateway and the QA
 * transport (host and Worker). It has no Node or Worker dependencies. */
export const INVALID_CACHE_USAGE = 'provider reported invalid cache usage';
export const MISSING_USAGE = 'provider omitted content or usage';
const count = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Reduces reported usage to total input (cache reads and writes included),
 * cache reads, cache writes and output. Input and output must be valid counts
 * (the caller retries a reply without them). A present cache field that is not
 * a non-negative safe integer, or verified counts above the input, is invalid:
 * on a verified route it throws (the reply was billed, so it is never retried);
 * on an unverified route the counts are recorded as null with convention
 * `invalid`, and the charge, which never depends on them there, is unchanged. */
export function normalizeUsage(protocol, usage, convention) {
  const anthropic = protocol === 'anthropic';
  const input = anthropic ? usage?.input_tokens : usage?.prompt_tokens;
  const output = anthropic ? usage?.output_tokens : usage?.completion_tokens;
  if (!count(input) || !count(output)) throw new Error(MISSING_USAGE);
  const read = anthropic ? usage.cache_read_input_tokens : usage.prompt_tokens_details?.cached_tokens;
  const write = anthropic ? usage.cache_creation_input_tokens : usage.prompt_tokens_details?.cache_write_tokens;
  let valid = [read, write].filter(v => v !== undefined && v !== null).every(count);
  // Anthropic's input_tokens excludes both cache counts; OpenAI's prompt_tokens
  // includes them.
  const total = anthropic && valid ? input + (read ?? 0) + (write ?? 0) : input;
  if (valid && !anthropic && convention === 'verified') valid = (read ?? 0) + (write ?? 0) <= input;
  if (!valid) {
    if (convention === 'verified') throw new Error(INVALID_CACHE_USAGE);
    return { input_tokens: total, cache_read_input_tokens: null, cache_write_input_tokens: null, output_tokens: output, usage_convention: 'invalid' };
  }
  if (!Number.isSafeInteger(total)) throw new Error(INVALID_CACHE_USAGE);
  return { input_tokens: total, cache_read_input_tokens: read ?? null, cache_write_input_tokens: write ?? null, output_tokens: output, usage_convention: convention };
}
