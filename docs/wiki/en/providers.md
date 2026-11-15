# Choose model providers and routes

## Outcome

Use a supported provider, your own compatible API, or a configured gateway route.

## Prerequisites

An online endpoint and provider credentials. Selected code/evidence can be sent to configured providers. Gateway authentication and upstream provider keys are distinct.

## Steps

Start with `rio profile show rio/openrouter` or `rio profile show rio/anthropic` to inspect model aliases. After supplying the corresponding key during setup, use `rio review --profile rio/openrouter --preset standard`. Inspect the resolved profile: `rio/base` contains no model routes. `rio/openrouter` reviews with Anthropic Opus 5.5 and verifies with OpenAI GPT-6.1 Sol, and reviews a change longer than one prompt in up to eight parts. Choose other models during [setup](hosting.md), or override the `default` and `verifier` aliases under `models` in a child profile.

For a custom endpoint, register it during init:

```sh
rio init --custom-provider my-api:openai:https://api.example.invalid/v1 --default-model custom-my-api/MODEL
```

Replace the example URL/model with your actual service. The protocol is `openai` or `anthropic`. The key is supplied privately as `AI_GATEWAY_PROVIDER_KEY_MY_API`: uppercase the slug and replace hyphens with underscores. Profile routes use `custom-my-api/MODEL`. `--verifier-model` can choose a separate verification route; a one-voter verifier must resolve to a different model than the default.

AI Gateway `compat/…` routes and configured `dynamic/ROUTE` routes are also supported. Their metadata, optional prices and custom-provider definitions live in `[deployment]`, while keys remain in secret storage. See the generated configuration/reference and [existing gateway examples](../../cloudflare.md#custom-endpoints-through-ai-gateway) for protocol-specific fields.

## Expected results

The resolved profile identifies model aliases/routes and reports show provider usage provenance. Missing routes or authentication become explicit failed/deferred work; they do not count as completed verification.

## Troubleshooting

Check slug normalization, protocol, base URL and the route's model name. A private endpoint must support the configured wire protocol; an OpenAI-compatible URL is not automatically Anthropic-compatible. Avoid credentials in URLs. Update private keys and run `rio deploy` to install changed Worker secrets.

Prompt caching is separate from gateway response caching. Deployment keeps gateway response caching and prompt logging disabled. `[deployment.prompt]` controls supported provider cache hints/layout switches; reports distinguish cache reads/writes and unavailable pricing. [Limits and accounting](budgets.md) explains how to interpret them.

## Next steps

[Bound model work](budgets.md), then [review a small change](review.md).
