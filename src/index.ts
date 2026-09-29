import { Hono } from "hono";
import { errorHandler } from "./middleware/error.js";
import { requireApiKey } from "./middleware/auth.js";
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

// Everything but /health needs the API key: callers are servers (e.g. a
// client's Next.js server), never browsers.
app.route("/health", health);
app.use("/v1/*", requireApiKey);
app.route("/v1/clients", submissions);

export default app;
