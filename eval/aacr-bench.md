# AACR-Bench with Rio

`aacr_bench.py` adapts Rio reports to the unmodified file semantic scoring
functions from [Alibaba's AACR-Bench](https://github.com/alibaba/aacr-bench).
It requires a POSIX host, Git, Python 3.11+, a built Rio CLI, a configured Rio
endpoint, and the benchmark's Python evaluation environment. The runner uses
only Python's standard library; scoring also needs upstream's dependencies.
The manifest records the upstream commit, dataset and binary hashes, profile
and selected instance IDs. Use the downloaded dataset's actual counts when
reporting coverage; upstream's advertised counts may differ.

## Prepare

```sh
git clone https://github.com/alibaba/aacr-bench.git /path/to/aacr-bench
cd /path/to/aacr-bench/evaluation
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m converters.aacr_bench --seed 42 --validate
```

Pin the upstream checkout to the commit you intend to evaluate before installing
its requirements. From Rio's root, build the CLI with
`cargo build --locked -p rio-cli`. Configure an authenticated endpoint using
Rio's normal configuration or `RIO_ENDPOINT_URL` and `RIO_API_TOKEN`. Select a
profile appropriate to that endpoint; the default is `rio/openrouter`.
Profile limits and missing tools remain part of the measured configuration.
`--config-dir` defaults to `RIO_CONFIG_DIR`, or the normal XDG Rio config path.
Keep credentials in private configuration or environment variables.

## Run

```sh
python3 eval/aacr_bench.py run \
  --aacr /path/to/aacr-bench \
  --dataset /path/to/aacr-bench/evaluation/data/aacr_bench.jsonl \
  --rio /absolute/path/to/rio/target/debug/rio \
  --profile /absolute/path/to/profile.yaml \
  --config-dir /private/rio-config \
  --temp-root /disposable/source-and-cache \
  --out eval/runs/aacr-bench-RUN \
  --concurrency 1
```

Omit `--limit` and `--instance` to run the entire dataset. Repository groups
are concurrent; instances within a repository run serially in an isolated
checkout. Start with one worker and size concurrency to your endpoint's container
capacity. `eval/runs/aacr-bench*/` is ignored by Git; keep datasets and evidence
out of commits. The runner deletes only its own temporary source and cache trees.
Each invocation copies the executable into a new owner-only temporary directory,
verifies its hash, and removes the copy after its workers exit.
Dependency preparation and tool execution belong to the configured endpoint;
the runner does not install benchmark project dependencies on the host.

The upstream converter maps `source_commit` to base and `target_commit` to
head. Some pairs have diverged, so Rio's `--base` merge-base selection would
review a different diff. The adapter checks out both trees to materialize Git
objects, checks out the exact base, and uses `git read-tree TARGET` followed
by `rio review --staged`. It verifies the staged Git tree equals the target
tree, and the report identifies the exact base and staged snapshot. No
synthetic commits or altered source files are introduced. Source annotations
are never copied into the checkout or sent to Rio.

`cases/INSTANCE/` preserves Git command ledgers, tree identities, CLI streams,
raw report, endpoint ID, audit and status. Failed invocations and wrong diff
identities do not create evaluator result files. Valid empty reports do.
Incomplete and partial reports retain those labels and their emitted comments.
`results/` is a format adapter, not another review run. It includes findings
and plausible risks shown by Rio, deduplicates by finding ID, and excludes
fixed, pre-existing and refuted findings. Only the primary location anchors
each comment, with message, trigger, impact and suggested fix as its text.

Existing run directories require `--resume` and identical binary, dataset,
upstream commit, profile and selection. Completed attempts, including failures,
are preserved; use a fresh directory for corrected attempts.
Pass the same `--profile` and `--config-dir` when resuming. Keep inherited
personal profiles unchanged for the duration of a run; resume checks the
selected profile and its resolved configuration against the saved copies.
Ctrl-C stops active process groups and cancels queued repository work. Interrupted
cases have no terminal status or evaluator result, so `--resume` retries them.

## Score

Supply `JUDGE_BASE_URL`, `JUDGE_API_KEY` and `JUDGE_MODEL` through private
environment configuration. Choose a real model supported by that endpoint;
the adapter refuses mock scoring. Review subprocesses do not receive these
judge-specific variables.

```sh
/path/to/aacr-bench/evaluation/.venv/bin/python eval/aacr_bench.py evaluate \
  --aacr /path/to/aacr-bench \
  --dataset /path/to/aacr-bench/evaluation/data/aacr_bench.jsonl \
  --out eval/runs/aacr-bench-RUN
```

The upstream evaluator matches generated comments against annotations in the
same file and supports one-to-many coverage. Precision counts generated
comments covering a previously uncovered annotation. Recall counts covered
annotations. Their harmonic mean is the balanced score. These are annotation
agreement metrics, not independent adjudication of every generated finding.

Upstream excludes missing results from denominators. Always report evaluated
and missing instance counts together with scores, and disclose incomplete
reports and provider errors. Judge failures invalidate the score. Full judge
answers are cached by exact inputs, upstream commit, endpoint and model;
scoring can be repeated while reviews finish without re-judging prior inputs.
`metrics.json` includes model identity, coverage and recorded review cost.
In `metrics.json`, `provenance.valid` indicates successful judging, while
`coverage_complete` indicates whether every selected instance has a result.
Neither establishes that every review completed without limitations. Audit
token totals include completed calls; reserved/failed calls with missing
usage cannot establish a complete cost total. Judge usage is not reported by
the upstream evaluator.

Run adapter checks with:

```sh
python3 -m unittest discover -s eval/tests -p test_aacr_bench.py -v
```
