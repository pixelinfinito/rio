/** Types for the shared usage normalizer; it has no Node dependencies. */
export const INVALID_CACHE_USAGE: string;
export const MISSING_USAGE: string;
export function normalizeUsage(
  protocol: "openai" | "anthropic",
  usage: any,
  convention: "verified" | "unverified",
): {
  input_tokens: number;
  cache_read_input_tokens: number | null;
  cache_write_input_tokens: number | null;
  output_tokens: number;
  usage_convention: "verified" | "unverified" | "invalid";
};
