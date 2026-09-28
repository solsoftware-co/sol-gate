import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// Unlike sol-notify / sol-integrate, this doesn't load wrangler.toml: this
// pool version (0.5.x, matching wrangler 3) can't run Workflows, and refuses
// to start with wrangler.toml's SUBMISSION_WORKFLOW binding. Nothing needs
// it — every test passes its own env (fake bindings, fake workflow) to
// app.request(), and the workflow's logic (services/process-submission.ts)
// is tested with a fake step. Keep these in sync with wrangler.toml.
export default defineWorkersConfig({
  test: {
    exclude: ["tests/e2e/**", "node_modules/**"],
    poolOptions: {
      workers: {
        miniflare: {
          compatibilityDate: "2024-09-23",
          compatibilityFlags: ["nodejs_compat"],
        },
      },
    },
  },
});
