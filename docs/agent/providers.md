# Model providers

AI review needs an online configured endpoint, model routes in the chosen profile and provider credentials. Provider calls may send selected source/evidence outside the account and consume money. Secrets must use environment/keychain/private files.

## standard
`rio review --profile rio/openrouter --preset standard` selects the built-in OpenRouter profile after setup. `rio profile show rio/openrouter` reveals actual model aliases/routes: by default Anthropic Opus 5.5 reviews, OpenAI GPT-6.1 Sol verifies, and a change longer than one prompt is reviewed in up to eight parts. Override models.default/models.verifier in a child profile, or choose them during init. Anthropic has a built-in profile too. rio/base has no model routes; choosing it does not configure AI by itself. Gateway authentication and provider credentials are separate.

## custom
During init use `--custom-provider SLUG:PROTOCOL:BASE_URL`, where PROTOCOL is openai or anthropic. Supply `AI_GATEWAY_PROVIDER_KEY_<SLUG>` (normalized environment suffix) privately; inspect setup's instructions for the slug. Profiles reference custom-SLUG/MODEL. AI Gateway's unified compat/ routes and dynamic/ROUTE are supported when registered/configured. Never embed credentials in BASE_URL.
Deployment configuration stores custom provider metadata, optional model prices and dynamic routes, not provider keys. Provider/model routing errors must be fixed in deployment/profile configuration, then validated and redeployed as needed. A route marked unavailable must not be treated as successful verification.

## caching
Provider prompt caching differs from gateway response caching. Deployment [deployment.prompt] cache/layout switches control supported prompt-cache hints and stable prompt layout. AI Gateway response caching and prompt logging are disabled by deployment. Read usage provenance in the report: cache read/write tokens can differ from normal input tokens. See budgets for ceilings; cached hypotheses still receive verification.
