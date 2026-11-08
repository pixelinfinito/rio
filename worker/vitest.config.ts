import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { generateKeyPairSync } from "node:crypto";
// A GitHub App key for the recorded GitHub double, generated per run so no
// private key is ever committed. GitHub issues PKCS#1 keys.
const app = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});
export default defineConfig({
  plugins: [
    cloudflareTest({
      config: false,
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-11-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        workflows: {
          REVIEWS: { name: "rio-review-test", className: "ReviewWorkflow" },
          MIGRATIONS: {
            name: "rio-migrate-test",
            className: "MigrationWorkflow",
          },
        },
        queueProducers: { JOBS: "rio-test-jobs" },
        r2Buckets: ["ARTIFACTS"],
        bindings: {
          RIO_VERSION: "0.2.0",
          OPENAI_API_KEY: "recorded-key",
          ANTHROPIC_API_KEY: "recorded-key",
          RIO_API_TOKEN: "test-owner-token-at-least-32-characters",
          RUNNER_SECRET: "test-runner-secret-at-least-32-characters",
          RUNNER_BACKEND: "self-hosted",
          GITHUB_APP_ID: "4242",
          GITHUB_APP_PRIVATE_KEY: app.privateKey,
          GITHUB_WEBHOOK_SECRET: "test-webhook-secret-at-least-32-characters",
          GITHUB_API_URL: "https://api.github.test",
          PUBLIC_URL: "https://rio.example.test",
          TEST_GITHUB_PUBLIC_KEY: app.publicKey,
        },
        durableObjects: { SANDBOX: "Sandbox" },
      },
    }),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    // Workflow and D1 round trips run in workerd; allow for loaded CI hosts.
    testTimeout: 30000,
  },
});
