# GitHub App

PR mode connects a Rio endpoint to GitHub through a GitHub App that the endpoint's owner registers once with `rio init`. The app lets the endpoint receive pull request webhooks, read the code of the repositories it is installed on, and post review comments and a check run. This document is the reference for the app's permissions, the registration flow, the secrets it creates, the webhook URL, how a pull request is prepared, reviewed and published, and how to rotate credentials. It describes the design in `openspec/changes/rio-v0-3-core/design.md` (decisions D1 to D7) as implemented by task groups 1 to 3 of that change.

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
  "name": "Rio review <endpoint host>",
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

`installation` and `installation_repositories` deliveries reach every app without subscription, so they are not listed in `default_events`. The name is the endpoint host without `.workers.dev`, cut to GitHub's 34-character limit (for example `Rio review rio.rio-210f84d0a5c4`); app names are unique on GitHub, and the host makes it so.

## Registration (manifest flow)

1. `rio init` offers "Register a GitHub App" after deploying the endpoint; `rio init --github-app` selects it non-interactively (`--github-org ORG` registers it under an organization). The choice is recorded in `config.toml` (`[deployment] github_app = true`), so `rio init --from config.toml` replays it. Declining, or running without a terminal and without the flag, skips the step and nothing else changes.
2. The CLI starts a loopback listener on `127.0.0.1` with a random port and a one-time `state` value, prints and opens `http://127.0.0.1:<port>/`, and that page posts the manifest above to `https://github.com/settings/apps/new?state=<state>` (or `/organizations/<org>/settings/apps/new`).
3. The user confirms the app on GitHub. GitHub redirects to `http://127.0.0.1:<port>/github-app/callback` with a temporary `code`; the listener refuses a mismatched `state` and waits up to ten minutes.
4. The CLI exchanges the code with `POST https://api.github.com/app-manifests/<code>/conversions`, which returns the app id, the PEM private key, the webhook secret and the client credentials.
5. The CLI stores `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET` as Worker secrets through the Cloudflare API, from memory, and discards the client id and client secret (PR mode does not use OAuth). Nothing secret is written to disk; `config.toml` records only `[github_app] app_id`, `slug` and `installation_url`.
6. The CLI prints the installation URL (`https://github.com/apps/<slug>/installations/new`). Installing the app on repositories sends an `installation` event that the endpoint records.

A replay on a machine whose `config.toml` already names an app, against an endpoint that already holds its secrets, keeps that app and registers nothing.

## Secrets

| Worker secret | Content | Written by |
| --- | --- | --- |
| `GITHUB_APP_ID` | Numeric app id | `rio init` GitHub App step |
| `GITHUB_APP_PRIVATE_KEY` | PEM private key that signs the App JWT | `rio init` GitHub App step, key rotation |
| `GITHUB_WEBHOOK_SECRET` | HMAC key for `X-Hub-Signature-256` | `rio init` GitHub App step, `rio doctor --rotate` |

The endpoint never stores installation tokens. For each job it signs an App JWT (RS256, at most ten minutes) with the private key and exchanges it for an installation token scoped to one repository and to the job's permissions: `contents: read` for the clone of a self-hosted `prepare` job; `contents: read` and `pull_requests: read` to read the pull request and, on the Sandbox, its tarballs; `pull_requests: write` and `checks: write` for publication; `pull_requests: write` and `metadata: read` for `/rio` commands. GitHub issues every installation token for one hour; Rio holds each under a ten-minute lease (requests after it fail) and revokes it with `DELETE /installation/token` as soon as the job phase that needed it ends: the Worker after reading or publishing, the clone container after cloning (and the runner host again, in case the container failed first). A self-hosted runner receives its clone token and its single-use prepare credential in the claim response only; neither is stored in a job payload, a log or a report.

## Webhook URL and verification

The webhook URL is `https://<worker>/v1/hooks/github`, where `<worker>` is the endpoint host from `config.toml`. A delivery is accepted only when:

- `X-Hub-Signature-256` is a valid HMAC-SHA256 of the raw request body with `GITHUB_WEBHOOK_SECRET`;
- `X-GitHub-Delivery` has not been seen in the previous 24 hours (table `deliveries`); a repeat is acknowledged with no effect;
- the installation in the payload is registered (table `installations`), except for the `installation` event that registers it.

Without the app secrets the route returns 404. A bad signature returns 401, an unknown installation 403, an accepted delivery 202 (a repeat `{"duplicate": true}`), and an ignored event or action 204: drafts until `ready_for_review`, PRs of repositories the installation does not cover, comments that do not start with `/rio`, and comments by bots. The signature is checked over the raw bytes before the body is parsed. The handler never calls GitHub or a model; it records installation changes, enqueues a `review-request` or `command` message and returns within GitHub's ten-second delivery timeout; work that fails on the queue is retried there, never by GitHub's redelivery. `/v1/hooks/gitlab` is reserved and returns 501.

## Rotation

- **Webhook secret.** `rio doctor --rotate` needs a deployment made with `rio init` (it sets Worker secrets through Cloudflare). It generates a new secret and:
  1. stores it as `GITHUB_WEBHOOK_SECRET_NEXT`, which the endpoint accepts beside the current secret;
  2. verifies that the endpoint accepts a `ping` signed with it (retrying for up to a minute while the new Worker version spreads);
  3. asks the endpoint to set it on the app (`POST /v1/github/hook-config`, owner token; the endpoint calls `PATCH /app/hook/config` with its App JWT, since only it holds the private key);
  4. stores it as `GITHUB_WEBHOOK_SECRET`, removes `GITHUB_WEBHOOK_SECRET_NEXT` and verifies a signed `ping` again.

  If a step fails, the previous secret stays in effect on both sides: the temporary secret is removed, and after step 4 fails the endpoint puts its unchanged secret back on the app. The command names the failing step and exits 1.
- **Private key.** Generate a new key in the app's settings on GitHub, run `rio init --replace-private-key <file.pem>` to store it as `GITHUB_APP_PRIVATE_KEY` (the file is GitHub's download; Rio reads it once and sends it to the Worker), confirm with `rio doctor` that the endpoint answers, then delete the old key on GitHub. Tokens minted with the old key expire within an hour and were revoked after their job anyway.
- **Uninstalling.** Removing the app from a repository or account sends an `installation` or `installation_repositories` event; the endpoint stops reviewing and publishing for those repositories at once. Deleting the Worker secrets disables the webhook route (404) without affecting CLI reviews.

## Pull request reviews

- **Requests.** An accepted `pull_request` event, a maintainer's `/rio review` or `rio review --pr <n>` (`POST /v1/pulls`) queues a review request. The queue consumer reads the pull request from GitHub (head, merge base, fork flag from `head.repo` against `base.repo`, author login and type, agent attribution from a bot author or a `Co-authored-by` trailer naming a known agent) and creates one review per head: a second delivery for the same head reuses it. The review joins the `pr` lineage `github.com/<owner>/<repo>` / `<number>`; a maintainer's `/rio review` resets it.
- **Policy.** The review runs under the repository's `.rio/profiles/default.yaml` **at the pull request's merge base** (else `rio/base`): the change under review never sets its own policy, and the endpoint, not the runner, sets the fork flag, lineage, repository key and pull request metadata of the submission. `rio/base` publishes nothing (`publish: never`) and names no models, so a repository opts in with its own default profile.
- **Preparation.** On the self-hosted runner a `prepare` job clones the two commits in a container with network and the clone token, then runs `rio prepare --output` in a second container on Docker's `none` network (which first checks that it has no route and no token), and the runner host uploads the snapshot and submits with the single-use prepare credential. `RIO_RUNNER_CLONE_NETWORK` picks the clone phase's Docker network (default `bridge`) and `RIO_RUNNER_GIT_CA` adds a private CA for GitHub Enterprise. On the Sandbox the Worker downloads both commits as tarballs and stores them as a snapshot, and the container prepares from it without network; the Sandbox never prepares a fork PR (the review records `fork_requires_self_hosted_runner`). Hosted checks follow the dependency rules of local reviews: a project whose dependencies are neither vendored nor installed in the snapshot has its typecheck, lint and coverage skipped with the reason and hint.
- **Publication.** The publish step runs after the report. Under `publish: never` nothing is posted. Under `auto` the publisher posts each finding whose primary line is in the diff as a review comment ending with `<!-- rio:finding:<identity> -->`, lists the others in one summary comment per lineage (`<!-- rio:summary:<lineage id> -->`), and creates or updates a `rio/review` check run on the head, always `neutral`. Under `ask`, webhook and command reviews post the check run only, and `rio review --pr <n>` publishes with `--publish` or after the user agrees at the prompt (`POST /v1/reviews/<id>/publish`). A fork PR publishes nothing until a maintainer's `/rio review`. Later rounds edit comments in place, resolve threads of fixed and dismissed findings and unresolve reopened ones; before posting, the publisher finds its own earlier comments by their markers, so a lost record never duplicates a comment. A finding identity is posted at most once per lineage, and a dismissed finding, or one dismissed as `wrong` in an earlier pull request, is never posted. A rejected comment is recorded `failed`, listed in the summary and retried on the next round; `rio review --pr` exits 5 when publication failed after a review that otherwise passed. The report's `publication` object has the counts, the URLs and, when nothing or only the check run was posted, the reason.
- **Commands.** `/rio review` from a maintainer (`admin` or `maintain`) requests a new review and resets the lineage; `/rio dismiss <id> <reason> [note]` from a collaborator or maintainer (`write`, `triage`, `admin`, `maintain`) records the same `author_response` as `POST /v1/findings/{id}/feedback`, where `<id>` is the identity or an unambiguous prefix of at least eight characters of a finding posted in the PR's lineage. The role comes from `GET /repos/{owner}/{repo}/collaborators/{user}/permission`, never from the comment payload. Results are reactions (`+1` applied, `-1` not applied) and comment edits; comments by bots, including the app, are ignored.

## Diagnostics

With an endpoint configured, `rio doctor` reports the endpoint's version and whether it speaks this CLI's protocol, whether the app secrets are configured on the endpoint, whether an installation covers the repository's `origin` (`GET /v1/github/installation`; a missing installation is a warning with the install URL and does not change the exit code), and the default profile's `publish` policy.
