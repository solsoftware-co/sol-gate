import { Hono } from "hono";
import { errorHandler } from "./middleware/error.js";
import health from "./routes/health.js";
import submissions from "./routes/submissions.js";
import { parseEnvironment } from "./lib/environment.js";
import { TRACE_ID_HEADER, withLogScope } from "./lib/log-context.js";
import { notFoundResponse } from "./lib/responses.js";
import type { AppEnv } from "./types/index.js";

export { SubmissionWorkflow } from "./workflows/submission.js";

const app = new Hono<AppEnv>();

app.onError(errorHandler);
app.notFound((c) => notFoundResponse(c, "Not found"));
app.use("*", async (c, next) => {
  // Every request starts a trace (SOL-46): its traceId is on every log line,
  // forwarded to the internal services and returned as X-Trace-Id. Never the
  // caller's — Sol Gate is the public front door. The submissions route adds
  // the submissionId.
  const traceId = crypto.randomUUID();
  c.set("traceId", traceId);
  c.header(TRACE_ID_HEADER, traceId);

  await withLogScope({ environment: c.env.ENVIRONMENT, traceId }, async () => {
    // Fail fast on a misconfigured ENVIRONMENT, on every route (including
    // /health) — same as sol-notify and sol-integrate.
    parseEnvironment(c.env.ENVIRONMENT);
    await next();
  });
});

// /health is open; submissions need a key of the form they submit to
// (routes/submissions.ts → lib/form-key.ts).
app.route("/health", health);
app.route("/v1/clients", submissions);

export default app;
