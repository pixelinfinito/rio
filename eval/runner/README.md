# One public PR, reproducibly

Requirements: Python 3 (standard library only), Git, a built Rio binary, and the
project's pinned runtime/package-manager versions. The runner supports public
GitHub PRs, including fetched fork heads. Dependency installers and project tests
execute project code; use a disposable machine/container appropriate for the PR.
`--offline` prevents Rio network requests, not installer or test network access.

From the Rio repository root:

```sh
cargo build --locked -p rio-cli
python3 eval/runner.py \
  --repository OWNER/REPO --pr NUMBER --languages typescript \
  --rio "$PWD/target/debug/rio" --out "$PWD/eval/runs/CASE"
```

For unattended reruns, pass `--base FULL_BASE_SHA --head FULL_HEAD_SHA`; otherwise
the runner resolves both via the public GitHub API once and saves its response.
For Python use `--languages python`; a mixed PR can list both languages. Use a
new output directory for every attempt; existing evidence is never overwritten.
The API base may have advanced since the PR branched: the runner computes and
records the merge base, checks that exact base out, and verifies Rio reports
that base and the pinned head. The requested/API base is preserved separately.

The runner clones independent base and head source trees under a temporary
parent, installs each checkout from its own lockfile, runs `rio doctor`, and runs:

```sh
rio review --base FULL_MERGE_BASE_SHA --format json --offline --profile rio/base
```

`--profile PATH` pins a custom profile. The default explicitly selects `rio/base`
to avoid a cloned repository silently changing the cohort profile. The input
profile (when supplied), resolved profile output/hash, binary hash/version,
runtime version outputs, exact subprocess argv/cwd/environment overrides,
wall times, exit codes, lockfile hashes, and full stdout/stderr paths are retained
in the output directory. `RIO_*` machine overrides are removed and named in the
manifest; config/cache directories are fresh and disposable. Record any other
runtime-affecting environment and container image in the verdict notes. Source
clones, installations, and Rio cache are removed when the run finishes; copy
additional reproductions out before conducting separate experiments.

Automatic installers are `corepack pnpm install --frozen-lockfile`, Corepack Yarn
(`--frozen-lockfile` for Yarn 1, `--immutable` for newer pinned versions), `npm ci`,
and `uv sync --locked --all-groups --all-extras`. Install the right Node/Python and
Corepack/uv versions first. A Yarn lock without `packageManager` defaults to Yarn
1; pass an install plan for repositories that pin versions elsewhere. Automatic
selection handles one root package manager; mixed-language repositories and
nested workspaces may need a plan. Unsupported lockfiles, missing optional extras,
or installation failures need a corrected plan; the runner still attempts Rio
and preserves the environment failure rather than declaring a clean change.

For repository-specific commands supply a JSON `--install-plan PATH`:

```json
{
  "base": [["uv", "sync", "--locked", "--group", "test"]],
  "head": [["uv", "sync", "--locked", "--group", "test"]]
}
```

Each command is an argv array, run sequentially at that checkout root, without a
shell. Include every required lint/typecheck/coverage extra and preserve locked
versions. For hashed pip requirements a plan can create `.venv` with
`python3 -m venv .venv` and run `.venv/bin/pip install --require-hashes -r ...`.
Never create or update a tracked lockfile to hide incompatibility. Changes to
tracked files abort the run. Set `--timeout SECONDS` for per-command limits;
`--temp-root PATH` selects the disposable parent.

Outputs:

- `commands.json`: exact command ledger, install results, pins, environment
  dependency state, baseline execution/classification evidence, and failures.
- `report.json`, `doctor.json`, `rio-version.txt`, `resolved-profile.txt`, logs:
  raw evidence, including nonzero Rio exit statuses.
- `verdicts.json`: editable adjudication skeleton. `TODO` entries are deliberately
  invalid for scoring. This is not a completed per-PR record.

Exit 0 means evidence capture had no known setup failure; exit 1 preserves
failures for repair, including absent baseline classification. A Rio exit 1 is
not itself a runner failure: valid findings are expected in positive controls.
Fatal setup/invalid JSON failures retain the ledger and logs even when no report
or skeleton could be created. Eligibility always comes from the report, not the
install command's exit status. Both installations succeeding does not establish
Rio can classify its base: it currently uses the head's dependency installation
for its own base snapshot. Trusted dependencies, differing lockfiles, executable
`.pth` files, or unsupported installation metadata may still block it. Fix the
setup or product compatibility issue and rerun; do not score an unclassified run.

Fill all verdicts, reviewer identity, independent clean assessment, expected bugs,
misses, and evidence reasons, then follow [the main workflow](../README.md).
