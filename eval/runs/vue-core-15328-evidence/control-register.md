# Negative-control registration (before Rio)

PR https://github.com/vuejs/core/pull/15328 was merged by the project on 2026-08-27 and authored by maintainer edison1105 (GitHub MEMBER).
Kind: none (negative control). No expected deterministic bug.
Base `a2b40db9a83b36ed9da3a16403cf8f040262d73f`, original PR head `57c730ab498aba29c525099d0a32529ff6d392e4`. Source changes are confined to packages/shared/src/looseEqual.ts; two regression test files cover Map/Set comparisons and v-model use.
Independent clean assessment requires completed root `pnpm check`, root `pnpm lint`, and targeted instrumented shared tests on both revisions; evidence logs and exact argv/exit codes are saved here before Rio runs.
Node 24.22.2 (pinned resolution of lts/*), Corepack 0.34.6, pnpm 11.19.0; frozen workspace install, no lockfile changes, PUPPETEER_SKIP_DOWNLOAD=true.
Same profile as positive: ../vue-core-setup/profile.yaml, SHA-256 54923428bdf61617ff4f2dc8555ae85ca45e40511dcb9e344ad6deff777ea206. All default checks enabled; only wall-time budget raised to 20m. Dependency trust false.
Reviewer: sub-agent eval-vue-core (automated); verdict_source automated. This assessment does not prove semantic correctness beyond the inspected change and executed oracles.

All independent oracle commands completed before Rio: base/head root pnpm check exit 0; base/head root pnpm lint exit 0; instrumented shared looseEqual tests exit 0 (12 tests at base, 14 at head). Head coverage has 61 statements, with only two unexecuted statements on unchanged line 87; all introduced statements execute. This supports the independently clean deterministic assessment. Exact raw counters are in head-coverage/coverage-final.json and logs/command ledgers here.

Provenance correction after run (2026-11-05 02:49 UTC): the separately installed Corepack 0.34.6 was shadowed by Node’s bundled Corepack 0.36.0, as shown by the runner’s `corepack --version` log. All oracles and both attempts used the same pinned PATH and therefore this bundled version. The Node/pnpm pins and expectation are unchanged.
