# Commands and settings reference

Look up an exact command, file, setting, or exit code. For a walkthrough, use [Guides](guides.md). Open **All command options** in a linked guide for its complete parser-generated argument table.

## Common lookups

| Find | Reference |
| --- | --- |
| Review selection: working tree, staged files, branch or PR | [Review commands](review.md#command-reference) |
| Keyboard shortcuts and interactive screens | [Terminal UI](tui.md) |
| Findings, evidence, incomplete results, exit codes and export formats | [Results](results.md) |
| Profile inheritance, defaults and list replacement | [Profiles](profiles.md) |
| Machine settings, environment variables and precedence | [Configuration](configuration.md) |
| Model routes, verification and resource limits | [Providers](providers.md) · [Budgets](budgets.md) |
| Steps, modules, adapters and all schema fields | [Module and schema reference](modules.md) |
| Local agent documentation and JSON envelopes | [Embedded docs](docs.md) |

## Configuration files

| File or location | Purpose | Details |
| --- | --- | --- |
| `.rio/profiles/default.yaml` | Repository review policy and default steps | [Profiles](profiles.md) |
| `.rio/profiles/NAME.yaml` | Named repository profile | [Profiles](profiles.md) |
| User config directory: `config.toml`, `profiles/` | Endpoint, cache, machine limits and personal profiles | [Paths and precedence](configuration.md) |
| `.rio/qa.yaml` | App startup, personas and browser configuration | [QA setup](qa.md) |
| Journey YAML and `REVIEW.md` | User journeys and owner guidance | [Journeys](qa-journeys.md) |
| Seed and fixture contracts | Synthetic app data and service/file fixtures | [Seeds and fixtures](qa-seeds.md) |
| `.rio/cache` | Default repository cache, not user configuration | [Cache and privacy](cache.md) |

## Environment variables

| Group | Keys | Details |
| --- | --- | --- |
| Machine configuration | `RIO_CONFIG_DIR`, `XDG_CONFIG_HOME`, `RIO_ENDPOINT_URL`, `RIO_PARALLELISM`, `RIO_OUTPUT_LIMIT` | [Configuration](configuration.md) |
| Cache | `RIO_CACHE_DIR`, `RIO_CACHE_MAX_AGE`, `RIO_CACHE_MAX_SIZE`, `RIO_CACHE_RETAIN_RAW_OUTPUT` | [Configuration](configuration.md) · [Cache](cache.md) |
| Terminal | `RIO_TUI`, `RIO_ASCII`, `NO_COLOR` | [Terminal UI](tui.md) |
| Installation | `RIO_VERSION`, `RIO_INSTALL_DIR`, `RIO_DOWNLOAD_BASE` | [Installation](installation.md) |
| Credentials | `RIO_API_TOKEN`, provider keys and runner secrets | [Connection and deployment](hosting.md) · [Providers](providers.md). Supply secrets privately. |

## Exit codes

Codes depend on the command. A nonzero review exit may indicate findings or incomplete checks; `doctor` uses different codes, and publication can fail after a passing review. See the [command-specific exit-code table](results.md). For `rio docs`, see its [retrieval and error contract](docs.md).

<!-- command-index:start -->

## Command lookup

| Command | Guide / options |
| --- | --- |
| `rio` | [Commands and settings reference](reference.md#rio) |
| `rio docs` | [Give an agent documentation through the CLI](docs.md#rio-docs) |
| `rio review` | [Your first local review](review.md#rio-review) |
| `rio qa` | [Your first browser QA run](qa.md#rio-qa) |
| `rio qa init` | [Your first browser QA run](qa.md#rio-qa-init) |
| `rio qa validate` | [Your first browser QA run](qa.md#rio-qa-validate) |
| `rio qa list` | [Your first browser QA run](qa.md#rio-qa-list) |
| `rio qa show` | [Your first browser QA run](qa.md#rio-qa-show) |
| `rio qa fixtures` | [Prepare synthetic data and service fixtures](qa-seeds.md#rio-qa-fixtures) |
| `rio qa fixtures status` | [Prepare synthetic data and service fixtures](qa-seeds.md#rio-qa-fixtures-status) |
| `rio qa rules` | [Your first browser QA run](qa.md#rio-qa-rules) |
| `rio qa seed` | [Prepare synthetic data and service fixtures](qa-seeds.md#rio-qa-seed) |
| `rio qa seed build` | [Prepare synthetic data and service fixtures](qa-seeds.md#rio-qa-seed-build) |
| `rio qa seed export` | [Prepare synthetic data and service fixtures](qa-seeds.md#rio-qa-seed-export) |
| `rio qa seed prune` | [Prepare synthetic data and service fixtures](qa-seeds.md#rio-qa-seed-prune) |
| `rio qa seed status` | [Prepare synthetic data and service fixtures](qa-seeds.md#rio-qa-seed-status) |
| `rio qa evidence` | [Inspect QA evidence and UX recommendations](qa-evidence.md#rio-qa-evidence) |
| `rio qa evidence prune` | [Inspect QA evidence and UX recommendations](qa-evidence.md#rio-qa-evidence-prune) |
| `rio qa sync` | [Maintain journeys and owner guidance](qa-journeys.md#rio-qa-sync) |
| `rio profile` | [Adjust checks with profiles](profiles.md#rio-profile) |
| `rio profile list` | [Adjust checks with profiles](profiles.md#rio-profile-list) |
| `rio profile show` | [Adjust checks with profiles](profiles.md#rio-profile-show) |
| `rio profile validate` | [Adjust checks with profiles](profiles.md#rio-profile-validate) |
| `rio doctor` | [Diagnose tools and readiness](doctor.md#rio-doctor) |
| `rio init` | [Add AI review: connect or deploy](hosting.md#rio-init) |
| `rio deploy` | [Add AI review: connect or deploy](hosting.md#rio-deploy) |
| `rio feedback` | [Respond to findings and follow history](feedback.md#rio-feedback) |
| `rio findings` | [Respond to findings and follow history](feedback.md#rio-findings) |
| `rio suppressions` | [Apply or decline suppression proposals](suppressions.md#rio-suppressions) |
| `rio suppressions list` | [Apply or decline suppression proposals](suppressions.md#rio-suppressions-list) |
| `rio suppressions apply` | [Apply or decline suppression proposals](suppressions.md#rio-suppressions-apply) |
| `rio suppressions decline` | [Apply or decline suppression proposals](suppressions.md#rio-suppressions-decline) |
| `rio eval` | [Evaluate Rio with labeled cases](evaluation.md#rio-eval) |
| `rio eval noise` | [Evaluate Rio with labeled cases](evaluation.md#rio-eval-noise) |
| `rio eval import-incident` | [Evaluate Rio with labeled cases](evaluation.md#rio-eval-import-incident) |

<!-- command-index:end -->

<!-- schema-topics:start -->

## Complete schema tables

- [Profile fields](modules.md#profile-fields)
- [QA environment fields](modules.md#qa-environment-fields)
- [Journey fields](modules.md#journey-fields)
- [Seed fields](modules.md#seed-fields)
- [Fixture fields](modules.md#fixture-fields)

<details>
<summary>Earlier compact lookup pages</summary>

These existing URLs remain available. Prefer the complete tables above for reading; agents can retrieve small sections with `rio docs`.

- [profile-fields-1](profile-fields-1.md)
- [profile-fields-2](profile-fields-2.md)
- [qa-config-fields-1](qa-config-fields-1.md)
- [qa-journey-fields-1](qa-journey-fields-1.md)
- [qa-seed-fields-1](qa-seed-fields-1.md)
- [qa-fixtures-fields-1](qa-fixtures-fields-1.md)
- [qa-config-fields-2](qa-config-fields-2.md)

</details>

<!-- schema-topics:end -->

Internal `rio prepare` is a runner-only command. It is not part of normal user workflows.

<!-- commands:start -->

<details>
<summary>All command options</summary>

## Command reference

### `rio`

| Argument | Meaning | Default / choices |
| --- | --- | --- |
| `--help` | Show command syntax and supported options. | `—` |
| `--version` | Show Rio version, target triple and build commit. | `—` |

</details>

<!-- commands:end -->
