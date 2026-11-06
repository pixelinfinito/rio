import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { execFileSync } from "node:child_process";
import { format } from "prettier";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import standaloneCode from "ajv/dist/standalone/index.js";
const root = fileURLToPath(new URL("../../", import.meta.url));
const modules = {};
for (const name of readdirSync(`${root}/modules/steps`).sort()) {
  const manifest = parse(
    readFileSync(`${root}/modules/steps/${name}/module.yaml`, "utf8"),
  );
  modules[`${manifest.name}@${manifest.version}`] = manifest.schema;
}
const output = await format(JSON.stringify(modules), { parser: "json" }),
  path = `${root}/worker/src/step-schemas.json`;
if (process.argv.includes("--check")) {
  if (readFileSync(path, "utf8") !== output)
    throw new Error("Regenerate worker step schemas with npm run generate");
} else writeFileSync(path, output);
const secrets = JSON.parse(
  execFileSync(
    "python3",
    [
      "-c",
      'import json,sys,tomllib; print(json.dumps(tomllib.load(open(sys.argv[1],"rb"))))',
      `${root}/modules/adapters/common/secrets.toml`,
    ],
    { encoding: "utf8" },
  ),
);
const secretPath = `${root}/worker/src/secret-patterns.json`,
  secretOutput = await format(JSON.stringify(secrets), { parser: "json" });
if (process.argv.includes("--check")) {
  if (readFileSync(secretPath, "utf8") !== secretOutput)
    throw new Error("Regenerate shared secret patterns with npm run generate");
} else writeFileSync(secretPath, secretOutput);
const migrations = readdirSync(`${root}/worker/migrations`)
  .filter((n) => n.endsWith(".sql"))
  .sort()
  .map((name) => ({
    name,
    statements: readFileSync(`${root}/worker/migrations/${name}`, "utf8")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean),
  }));
const migrationPath = `${root}/worker/src/migrations.json`,
  migrationOutput = await format(JSON.stringify(migrations), {
    parser: "json",
  });
if (process.argv.includes("--check")) {
  if (readFileSync(migrationPath, "utf8") !== migrationOutput)
    throw new Error("Regenerate migration manifest with npm run generate");
} else writeFileSync(migrationPath, migrationOutput);
// Workers disallow runtime code generation. Compile schemas before shipping the bundle.
const ajv = new Ajv({
  strict: false,
  allErrors: true,
  code: { source: true, esm: true },
});
addFormats(ajv);
const exports = {};
for (const [name, file] of Object.entries({
  profile: "profile-v1",
  report: "report-v1",
  hypothesis: "hypothesis-v1",
  answer: "vote-answer-v1",
})) {
  ajv.addSchema(
    JSON.parse(readFileSync(`${root}/schemas/${file}.json`, "utf8")),
    name,
  );
  exports[name] = name;
}
Object.entries(modules).forEach(([, schema], i) => {
  const name = `module${i}`;
  ajv.addSchema(schema, name);
  exports[name] = name;
});
const validatorsPath = `${root}/worker/src/validators.generated.js`,
  validatorsOutput = await format(standaloneCode(ajv, exports), {
    parser: "babel",
  });
if (process.argv.includes("--check")) {
  if (readFileSync(validatorsPath, "utf8") !== validatorsOutput)
    throw new Error("Regenerate standalone validators with npm run generate");
} else writeFileSync(validatorsPath, validatorsOutput);
