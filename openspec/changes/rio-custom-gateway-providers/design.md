# Design

## Decisions

### D1. Keys live in the gateway, not the Worker

A custom provider's upstream key is applied as the provider's `headers` (a JSON-encoded string, write-only in Cloudflare) and kept in the deployment credential store under `AI_GATEWAY_PROVIDER_KEY_<SLUG>`, together with a fingerprint of the applied base URL and headers. Credential-store names with that prefix are never uploaded as Worker secrets. Alternative: Worker secrets per provider. Rejected: the gateway already authenticates the Worker with `AI_GATEWAY_TOKEN`, and a key in the Worker is one more copy to leak. Alternative: gateway BYOK provider configs. Rejected for now: they require a Secrets Store bound to the gateway, which deployments do not create.

### D2. Model identifiers select the route

`custom-SLUG/MODEL` uses the provider's native gateway endpoint (`chat/completions` or `messages` by protocol); `compat/PROVIDER/MODEL` and `dynamic/ROUTE` use the OpenAI-shaped unified endpoint. The Worker learns each slug's protocol from `AI_GATEWAY_PROVIDERS`. Built-in `openai/`, `anthropic/` and `openrouter/` routes are unchanged. `openai/custom-…` and `openai/dynamic/…` with a gateway go to the unified endpoint, which is what the manual `OPENAI_BASE_URL=<gateway>/compat` setup did, so its profiles survive a redeployment.

### D3. The base URL is the API root

A provider's base URL is the root that the endpoint path is appended to (usually ending in `/v1`), matching AI Gateway's rule that the path after `custom-SLUG/` is appended to `base_url`. Base URLs that end in an endpoint path are rejected, and all URL joins collapse slashes, so `/v1` is never duplicated.

### D4. Reconciliation is idempotent and conservative

Existing providers with the configured slug are adopted. Without a key Rio only corrects the base URL and enables the provider; with a key it rewrites headers only when the fingerprint changed. A missing provider without a key is an error naming the variable. Dynamic routes are compared by their elements; a difference creates and deploys one version. The Worker is always uploaded whole with every binding and the Container declaration.

### D5. Cost

Custom endpoints do not report prices. Cost stays `null` unless `model_prices` names the full profile model; a response `usage.cost` is trusted only from OpenRouter's own endpoint.

## Risks

- Write-only headers cannot be compared remotely; a key rotated outside Rio is not detected until Rio's key changes. The fingerprint makes Rio's own writes idempotent.
- Cloudflare may normalize route elements; a normalized echo would make each deployment create a version. The comparison uses JSON equality of the returned elements.
