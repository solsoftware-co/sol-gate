import type { Context } from "hono";
import { getForm, type Form } from "./sol-api.js";
import { isRateLimited } from "./rate-limit.js";
import { errorResponse, notFoundResponse } from "./responses.js";
import { logger } from "./logger.js";
import { ErrorCode, type AppEnv } from "../types/index.js";

export type FormLookup = { ok: true; form: Form } | { ok: false; response: Response };

// Rate limit, then load the form (client-scoped: another client's form is a
// 404, same as an unknown one).
export async function lookUpForm(c: Context<AppEnv>): Promise<FormLookup> {
  const { clientId, formId } = c.req.param() as { clientId: string; formId: string };

  if (await isRateLimited(c.env, clientId, formId)) {
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

  return { ok: true, form };
}
