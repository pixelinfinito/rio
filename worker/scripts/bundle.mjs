import { build } from "esbuild";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/index.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
  mainFields: ["module", "main"],
  conditions: ["workerd", "worker", "browser"],
  target: "es2023",
  external: ["cloudflare:*", "node:*"],
  minify: true,
  legalComments: "none",
});
const file = `${root}/bundle/worker.mjs`,
  output = result.outputFiles[0].contents;
if (process.argv.includes("--check")) {
  if (!readFileSync(file).equals(output))
    throw new Error("Embedded Worker is stale; run npm run bundle");
} else {
  mkdirSync(`${root}/bundle`, { recursive: true });
  writeFileSync(file, output);
}
