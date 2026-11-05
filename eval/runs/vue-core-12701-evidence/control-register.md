# Positive-control registration (before Rio)

Registered 2026-11-05 before first Rio review. Kind: real-pr.

- Repository/introducing PR: https://github.com/vuejs/core/pull/12701
- Language: typescript.
- Base: `35aeae7fa3168adcf9ed95fd35495d17c8b93eeb` (also merge base).
- Introducing head: `cc34f2e4b1490d55a18c9f8e4f83bda855a6e105` (original PR head).
- Expected ID: `nullable-source-map-column`.
- Mechanism: type-error. `m.originalColumn` is `number | null`, but `generator.addMapping`'s original column requires `number`. The preceding guard only narrows `m.originalLine`.
- Provenance: later maintainer fix #13366, commit `2c6c0794a1f1d8195024429f1be339ef7472463e`, adds a non-null assertion on this exact expression. Introducing change and subsequent fix are preserved in change.diff and later-fix-13366.diff.
- Independent oracle: `corepack pnpm check` at both pinned revisions; results in base-oracle-1.log, head-oracle-1.log, and corresponding oracle-commands.json. `corepack pnpm lint` is a supplementary check. Oracle evidence must be complete before Rio executes.
- Toolchain: Node 22.14.0, Corepack 0.34.6, pnpm 10.9.0, lockfile TypeScript 5.6.3. Base/head pnpm-lock SHA-256 both `aae6d1e05861866d49a735760fb32aa27d68e5dff97ce24c90487c3b40b39ebc`.
- Installer: frozen root pnpm workspace install, PUPPETEER_SKIP_DOWNLOAD=true. No tracked edits.
- Profile: ../vue-core-setup/profile.yaml, SHA-256 `54923428bdf61617ff4f2dc8555ae85ca45e40511dcb9e344ad6deff777ea206`; extends rio/base, changes only wall budget to 20m. Dependency trust remains false; all checks stay enabled. Rio's TypeScript adapter supports tsc diagnostics.
- Offline dependency audit: no changed dependency; no populated advisory-cache claim. This is a type-error control.
- Reviewer: sub-agent eval-vue-core (automated). verdict_source: automated.
- Rationale: direct introducing-line/follow-up-fix trace with unchanged locks, rather than a semantic regression or the correcting PR.
- First raw output directory: ../vue-core-12701. Failed setup attempts will remain and reruns use new directories.
- Detection finding IDs and baseline eligibility: fill in final verdicts.json after Rio.

Independent oracle completed before Rio: base pnpm check exit 0 (98.476s); head pnpm check exit 2 (97.236s), exactly TS2322 at compileScript.ts:1327; base/head pnpm lint both exit 0 (46.045s / 43.824s). Frozen oracle installs exit 0, 11m17.8s / 11m16.4s. Positive expectation confirmed independently.

Provenance correction after run (2026-11-05 02:49 UTC): the separately installed Corepack 0.34.6 was shadowed by Node’s bundled Corepack 0.31.0, as shown by the runner’s `corepack --version` log. All oracles and both attempts used the same pinned PATH and therefore this bundled version. The Node/pnpm pins and expectation are unchanged.
