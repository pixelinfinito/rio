# GitHub App

PR mode connects a Rio endpoint to GitHub through a GitHub App that the endpoint's owner registers once with `rio init`. The app lets the endpoint receive pull request webhooks, read the code of the repositories it is installed on, and post review comments and a check run. This document is the reference for the app's permissions, the registration flow, the secrets it creates, the webhook URL and how to rotate credentials. It describes the design in `openspec/changes/rio-v0-3-core/design.md` (decisions D1, D2, D6 and D7); the registration step, the webhook route and the publisher are implemented by task groups 1 and 3 of that change.

Without the app, the endpoint keeps working for CLI reviews: the webhook route returns 404 and `rio review --pr` exits 2 naming the GitHub App step of `rio init`.

## Permissions

The app's manifest declares exactly these repository permissions and nothing else. The manifest in `rio init` and this table are checked against each other by a test, so they cannot drift.

| Permission | Access | Used for |
| --- | --- | --- |
| `contents` | `read` | Cloning the base and head of a pull request in the hosted `prepare` job |
| `pull_requests` | `write` | Inline review comments, the summary comment, editing them, resolving threads |
| `checks` | `write` | The neutral `rio/review` check run on the head commit |
| `metadata` | `read` | Repository metadata, required by GitHub for every app |
| `members` | `read` | Classifying the author of a `/rio` command as maintainer, collaborator or other |

Webhook events the app subscribes to:

| Event | Actions handled | Effect |
| --- | --- | --- |
| `pull_request` | `opened`, `synchronize`, `reopened`, `ready_for_review` | Queues a review of the pull request head; drafts wait for `ready_for_review` |
| `issue_comment` | `created`, on a pull request, body starting with `/rio` | `/rio review` and `/rio dismiss <id> <reason>` |
| `installation` | `created`, `deleted`, `suspend`, `unsuspend` | Maintains the installation registry |
| `installation_repositories` | `added`, `removed` | Maintains the repositories an installation covers |

Every other event or action is acknowledged with 204 and ignored. Webhook payload text (titles, descriptions, commit messages, comment bodies) is data: it never changes posture, budgets, rules, suppressions, the publish policy or tool permissions.

The manifest `rio init` submits:

```json
{
  "name": "Rio review (<endpoint host>)",
  "url": "https://github.com/pixelinfinito/rio",
  "hook_attributes": { "url": "https://<worker>/v1/hooks/github", "active": true },
  "redirect_url": "http://127.0.0.1:<port>/github-app/callback",
  "public": false,
  "default_permissions": {
    "contents": "read",
    "pull_requests": "write",
    "checks": "write",
    "metadata": "read",
    "members": "read"
  },
  "default_events": ["pull_request", "issue_comment"]
}
```

`installation` and `installation_repositories` deliveries reach every app without subscription, so they are not listed in `default_events`.

## Registration (manifest flow)

1. `rio init` offers "Register a GitHub App" after the provider step; `rio init --github-app` selects it non-interactively and the choice is recorded in `config.toml` so `rio init --from config.toml` replays it. Declining skips the step and nothing else changes.
2. The CLI starts a loopback listener on `127.0.0.1` with a random port and a one-time `state` value, and opens `https://github.com/settings/apps/new?state=<state>` (or the organization form when an organization is given) with the manifest above posted from a local page.
3. The user confirms the app on GitHub. GitHub redirects to the loopback listener with a temporary `code`; the listener rejects a mismatched `state`.
4. The CLI exchanges the code with `POST https://api.github.com/app-manifests/<code>/conversions`, which returns the app id, the PEM private key, the webhook secret and the client credentials.
5. The CLI stores `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET` as Worker secrets through the Cloudflare API, in memory, and discards the client id and client secret (PR mode does not use OAuth). Nothing secret is written to disk unencrypted; `config.toml` records only the app id, the app slug and the installation URL.
6. The CLI prints the installation URL (`https://github.com/apps/<slug>/installations/new`). Installing the app on repositories sends an `installation` event that the endpoint records.

## Secrets

| Worker secret | Content | Written by |
| --- | --- | --- |
| `GITHUB_APP_ID` | Numeric app id | `rio init` GitHub App step |
| `GITHUB_APP_PRIVATE_KEY` | PEM private key that signs the App JWT | `rio init` GitHub App step, key rotation |
| `GITHUB_WEBHOOK_SECRET` | HMAC key for `X-Hub-Signature-256` | `rio init` GitHub App step, `rio doctor --rotate` |

The endpoint never stores installation tokens. For each job it signs a ten-minute App JWT with the private key, exchanges it for an installation token scoped to one repository and to the job's permissions (`contents: read` for a `prepare` job; `pull_requests: write` and `checks: write` for publication), passes the token inside that job's payload only, and lets it expire. Tokens are never persisted, logged or included in reports.

## Webhook URL and verification

The webhook URL is `https://<worker>/v1/hooks/github`, where `<worker>` is the endpoint host from `config.toml`. A delivery is accepted only when:

- `X-Hub-Signature-256` is a valid HMAC-SHA256 of the raw request body with `GITHUB_WEBHOOK_SECRET`;
- `X-GitHub-Delivery` has not been seen in the previous 24 hours (table `deliveries`); a repeat is acknowledged with no effect;
- the installation in the payload is registered (table `installations`), except for the `installation` event that registers it.

A bad signature returns 401 and an unknown installation 404. The handler never calls GitHub or a model; it enqueues a `review-request` message and returns within GitHub's ten-second delivery timeout. `/v1/hooks/gitlab` is reserved and returns 501.

## Rotation

- **Webhook secret.** `rio doctor --rotate` generates a new secret, updates the app's webhook configuration (`PATCH /app/hook/config` with an App JWT), updates `GITHUB_WEBHOOK_SECRET` on the endpoint, and verifies a ping delivery signed with the new secret. If any step fails, the previous secret stays in effect on both sides, the failing step is named, and the command exits 1.
- **Private key.** Generate a new key in the app's settings on GitHub, run `rio init --github-app` again and choose "replace private key" to store it as `GITHUB_APP_PRIVATE_KEY`, confirm with `rio doctor` that the endpoint can mint a token, then delete the old key on GitHub. Tokens minted with the old key expire within ten minutes.
- **Uninstalling.** Removing the app from a repository or account sends an `installation` or `installation_repositories` event; the endpoint stops reviewing and publishing for those repositories at once. Deleting the Worker secrets disables the webhook route (404) without affecting CLI reviews.

## Diagnostics

With an endpoint configured, `rio doctor` reports whether the app secrets are configured on the endpoint, whether an installation covers the repository's `origin` (a missing installation is a warning with the install URL and does not change the exit code), and the default profile's `publish` policy.
