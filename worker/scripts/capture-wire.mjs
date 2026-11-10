#!/usr/bin/env node
// Writes wire fixtures: node scripts/capture-wire.mjs <dir> ['<options json>']
// Bundles tests/wire/scenarios.ts, runs every scenario on every route with a
// capturing transport (no network) and writes tests/fixtures/wire/<dir>/<route>.json.
// The wire tests regenerate the same bodies and compare them byte for byte.
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [dir, options = "{}"] = process.argv.slice(2);
if (!dir || !/^[a-z0-9-]+$/.test(dir)) {
  console.error("usage: capture-wire.mjs <dir> ['<options json>']");
  process.exit(2);
}
const temp = mkdtempSync(join(tmpdir(), "rio-wire-"));
try {
  const out = join(temp, "scenarios.mjs");
  await build({
    entryPoints: [join(root, "tests/wire/scenarios.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: out,
    logLevel: "error",
  });
  const { captureAll } = await import(pathToFileURL(out).href);
  const captured = await captureAll(JSON.parse(options));
  const target = join(root, "tests/fixtures/wire", dir);
  mkdirSync(target, { recursive: true });
  for (const [route, scenarios] of Object.entries(captured))
    writeFileSync(join(target, `${route}.json`), `${JSON.stringify(scenarios, null, 2)}\n`);
  console.log(`wrote ${Object.keys(captured).length} route fixtures to ${target}`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
