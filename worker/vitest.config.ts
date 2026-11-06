import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
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
        },
        durableObjects: { SANDBOX: "Sandbox" },
      },
    }),
  ],
  test: { include: ["tests/**/*.test.ts"], fileParallelism: false },
});
