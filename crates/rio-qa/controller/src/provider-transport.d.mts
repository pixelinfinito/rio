/** Types for the shared host/Worker adapter; it has no Node dependencies. */
export function responseRequest(body: any): { names: Map<string, { name: string; namespace?: string }>; chat: any };
export function responseStream(result: any): string;
export function boundedJson(response: Response, limit?: number): Promise<any>;
export function providerTransport(options: {
  url: string | URL;
  headers: Record<string, string>;
  model: string;
  protocol?: "openai" | "anthropic";
  fetch?: typeof fetch;
}): (request: { path: string; body: any; signal: AbortSignal }) => Promise<Response>;
