# Deploy or connect

Deploying creates or updates resources in your Cloudflare account and may incur costs. Requires cf authentication or CLOUDFLARE_API_TOKEN, eligible account services and model credentials. Sandbox image transfer also needs Docker; self-hosted deployment does not need Docker on the deploying machine.

## connect
Existing endpoint: `rio init --endpoint https://YOUR-ENDPOINT --token-stdin`, providing API token on stdin. This saves user pairing configuration. `rio doctor` checks compatibility. API keys never belong in URLs or arguments. Endpoint connection conflicts with deployment flags.

## deploy
`cf auth login`, then `rio init` opens setup. Supply OPENROUTER_API_KEY, OPENAI_API_KEY or ANTHROPIC_API_KEY privately. `rio init --no-tui` uses terminal prompts. For scripted setup: --account ID, --name NAME, --cf-profile PROFILE, --runner sandbox|self-hosted, --runner-image IMAGE, --workers-subdomain NAME, --credential-store keychain|file, --secrets-file PRIVATE_JSON. --default-model and --verifier-model choose routes. --from CONFIG replays saved choices. --dry-run prints a plan without account changes.
Rio embeds the paired Worker; no npm/Wrangler checkout build is needed. It provisions Worker, Workflows, D1, R2, queue, AI Gateway and optional Sandbox in your account. Config stores choices; credentials use keychain by default or private files when explicitly selected. On headless machines choose file only if desired.

## maintain
`rio deploy` upgrades/reuses saved resources and resumes partial deployment. Rotate provider credentials privately and redeploy. Deployments never silently take over another Worker's bindings. `rio init --github-app [--github-org ORG]` adds PR integration. `rio init --replace-private-key FILE.pem` updates the registered App key. --council-vendor entries and --no-council manage council opt-in; see council.
For self-hosted execution configure the paired rio-runner/Docker host to poll the endpoint with its separate runner secret. Keep app source execution isolated from control-plane credentials. Authentication errors: verify cf profile/account and services; endpoint protocol errors: upgrade paired CLI/Worker/runner together.

## self-hosted
On a dedicated trusted Linux Docker host, check out matching Rio source. Privately supply RIO_RUNNER_SECRET=endpoint RUNNER_SECRET. Run `docker build -f worker/Dockerfile -t rio-runner:local .`, then `RIO_ENDPOINT_URL=https://YOUR-ENDPOINT cargo run --locked -p rio-runner -- serve --image rio-runner:local`. The local tag is a checkout-built image, not a release number. Keep polling active with a service manager. Never mount Docker socket, host workspace or credentials inside analysis containers.
