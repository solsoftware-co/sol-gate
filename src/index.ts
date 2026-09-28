import { Hono } from "hono";
import { errorHandler } from "./middleware/error.js";
import health from "./routes/health.js";
import submissions from "./routes/submissions.js";
import { parseEnvironment } from "./lib/environment.js";
import { notFoundResponse } from "./lib/responses.js";
import type { AppEnv } from "./types/index.js";

export { SubmissionWorkflow } from "./workflows/submission.js";

const app = new Hono<AppEnv>();

app.onError(errorHandler);
app.notFound((c) => notFoundResponse(c, "Not found"));
app.use("*", async (c, next) => {
  c.set("requestId", crypto.randomUUID());
  // Fail fast on a misconfigured ENVIRONMENT, on every route (including
  // /health) — same as sol-notify and sol-integrate.
  parseEnvironment(c.env.ENVIRONMENT);
  await next();
});

// Public: no API key. Abuse protection is per form — rate limits, Origin
// against allowed_origins, Turnstile (routes/submissions.ts).
app.route("/health", health);
app.route("/v1/clients", submissions);

export default app;
