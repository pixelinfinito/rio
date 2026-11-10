#!/usr/bin/env node
// The opt-in live prompt-cache measurement (docs/evaluation/prompt-caching.md).
// Sends billed requests: it exits before any network call unless
// RIO_LIVE_PROMPT_CACHE=1, a spend cap and every route's key are present.
//
//   RIO_LIVE_PROMPT_CACHE=1 ANTHROPIC_API_KEY=... MODEL_PRICES='{...}' \
//     node scripts/measure-prompt-cache.mjs --routes anthropic/claude-sonnet-5-5 \
//     --repetitions 5 --spend-cap 5 --out measurement.json
//   node scripts/measure-prompt-cache.mjs --council-audit audit.json   # (i), no network
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// esbuild is a Worker development dependency (npm ci --prefix worker).
const { build } = createRequire(join(root, "worker/package.json"))("esbuild");
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(" ")
    .split(/\s*--/)
    .filter(Boolean)
    .map((a) => a.split(/\s+/)),
);
const temp = mkdtempSync(join(tmpdir(), "rio-measure-"));
try {
  const out = join(temp, "measure.mjs");
  await build({
    entryPoints: [join(root, "worker/scripts/measure-prompt-cache.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: out,
    logLevel: "error",
  });
  const { measure, councilGaps } = await import(pathToFileURL(out).href);
  if (args["council-audit"]) {
    const audit = JSON.parse(readFileSync(args["council-audit"], "utf8"));
    console.log(JSON.stringify(councilGaps(audit), null, 2));
    process.exit(0);
  }
  const plan = {
    routes: (args.routes ?? "").split(",").filter(Boolean),
    repetitions: Number(args.repetitions ?? 5),
    spendCapUsd: Number(args["spend-cap"] ?? 0),
  };
  const result = await measure(process.env, plan);
  if (result.status === "refused") {
    console.error(`not run: ${result.reason}`);
    process.exit(2);
  }
  const file = args.out ?? "prompt-cache-measurement.json";
  writeFileSync(
    file,
    `${JSON.stringify({ at: new Date().toISOString(), plan, records: result.records }, null, 2)}\n`,
  );
  console.log(`wrote ${result.records.length} records to ${file}`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
