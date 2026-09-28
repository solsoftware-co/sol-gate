import type { Context } from "hono";
import { getForm, type Form } from "./sol-api.js";
import { isAllowedOrigin } from "./origin.js";
import { isRateLimited } from "./rate-limit.js";
import { errorResponse, forbiddenResponse, notFoundResponse } from "./responses.js";
import { logger } from "./logger.js";
import { ErrorCode, type AppEnv } from "../types/index.js";

export type FormLookup = { ok: true; form: Form; origin: string } | { ok: false; response: Response };

// Shared by the submission route's preflight and POST: rate limit, load the
// form, check the Origin against its allowed_origins. On success, every
// later response carries CORS headers for that origin (so the browser can
// read a 422's details); failures never do.
export async function lookUpForm(c: Context<AppEnv>): Promise<FormLookup> {
  const { clientId, formId } = c.req.param() as { clientId: string; formId: string };

  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  if (await isRateLimited(c.env, ip, clientId, formId)) {
    c.header("Retry-After", "60");
    return { ok: false, response: errorResponse(c, 429, ErrorCode.RATE_LIMITED, "Too many requests") };
  }

  let form: Form | null;
  try {
    form = await getForm(c.env, clientId, formId);
  } catch (err) {
    logger.error("couldn't load form", { requestId: c.get("requestId"), clientId, formId, errorMessage: String(err) });
    return { ok: false, response: errorResponse(c, 503, ErrorCode.SERVICE_UNAVAILABLE, "Service unavailable") };
  }
  if (!form) return { ok: false, response: notFoundResponse(c, "Form not found") };

  const origin = c.req.header("Origin");
  if (!isAllowedOrigin(origin, form.allowedOrigins)) {
    logger.warn("rejected submission: origin not allowed", { requestId: c.get("requestId"), clientId, formId, origin });
    return { ok: false, response: forbiddenResponse(c, "Origin not allowed") };
  }

  c.header("Access-Control-Allow-Origin", origin);
  c.header("Vary", "Origin");
  return { ok: true, form, origin };
}
