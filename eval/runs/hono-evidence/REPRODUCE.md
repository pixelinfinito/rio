# Reproduce final compatible Hono cases

Use unchanged Rio binary `/home/ubuntu/rio/target/release/rio` (`b15dc8ff5001`), Node20.10.0, Corepack0.36.0, and Yarn1.22.22. The exact tool/profile/patch/launcher hashes are in `2085-toolchain-provenance.json`, registrations and runner ledgers. `COREPACK_ENABLE_AUTO_PIN=0` prevents Corepack adding a packageManager field. Unset `NO_COLOR` because upstream tests expect colors by default.

From this Rio worktree, with the pinned Node/Corepack on PATH:

```sh
corepack prepare yarn@1.22.22 --activate
export COREPACK_ENABLE_AUTO_PIN=0
unset NO_COLOR
python3 eval/runner.py --repository honojs/hono --pr 2081 \
  --base 4ec3a9bf41ec3de004836e84757c07ec2b7b4156 \
  --head 310c8733dbde15f6b279863798e740953a4341dd \
  --languages typescript --rio /home/ubuntu/rio/target/release/rio \
  --install-plan eval/runs/hono-evidence/install-plan-vitest11-shim.json \
  --profile eval/runs/hono-evidence/profile.yaml \
  --out "$PWD/eval/runs/hono-2081-reproduction-NEW"
```

To reconstruct the synthetic head (not a public PR head), clone the public history, then fetch the preserved minimal bundle:

```sh
git clone https://github.com/honojs/hono.git /tmp/rio-hono-seed-repro
git -C /tmp/rio-hono-seed-repro fetch \
  "$PWD/eval/runs/hono-evidence/2085-seed.bundle" rio-eval-2085-seed
git -C /tmp/rio-hono-seed-repro checkout -b rio-eval-2085-seed FETCH_HEAD
GIT_CONFIG_COUNT=1 \
GIT_CONFIG_KEY_0=url.file:///tmp/rio-hono-seed-repro.insteadOf \
GIT_CONFIG_VALUE_0=https://github.com/honojs/hono.git \
python3 eval/runner.py --repository honojs/hono --pr 2085 \
  --case-id 2085-seeded-type-error-20261105 \
  --base b23cf8d65d851de9726d6388b45dda39e6fdb9ab \
  --head 94d2dcbf315dd3ac969d321b532fb0049b1a7c36 \
  --languages typescript --rio /home/ubuntu/rio/target/release/rio \
  --install-plan eval/runs/hono-evidence/install-plan-vitest11-shim.json \
  --profile eval/runs/hono-evidence/profile.yaml \
  --out "$PWD/eval/runs/hono-2085-seed-reproduction-NEW"
```

Always use a new attempt directory. The compatibility launcher alters only the CLI spelling for coverage enablement and worker limits, preserves original package files and exit status, and forwards all test/config/report arguments. It does not change source, lockfiles, package versions, checks, findings, or dependency trust. Its exact contents are in `vitest-cli-shim.txt`; the install plan embeds the same text and prints its hash. Without the launcher, this old Vitest rejects Rio's invocation; that is an observed compatibility limitation, not a clean setup.

Independent oracles use the original installed executables directly, before Rio, with supported `--coverage.enabled --coverage.all` and `VITEST_MAX_THREADS=2 VITEST_MIN_THREADS=1 VITEST_MAX_FORKS=2 VITEST_MIN_FORKS=1`. Exact per-version commands, output, zero-context diff, counters, and byte-identical emitted JavaScript evidence are in `../hono-2081-oracle/` and `../hono-2085-seed-oracle/`.
