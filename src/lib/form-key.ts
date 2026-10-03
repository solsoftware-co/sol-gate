import type { Context } from "hono";
import { verifyFormApiKey } from "./sol-api.js";
import { errorResponse } from "./responses.js";
import { logger } from "./logger.js";
import { ErrorCode, type AppEnv } from "../types/index.js";

// Every form has its own keys (sol-api's form_api_keys, SOL-42), created and
// revoked through sol-api. Callers are servers (e.g. a client's Next.js
// Server Action) that keep the key secret; a key in browser code would be
// public. A key only ever opens the one form it belongs to.

const KEY_PREFIX = "sgk_";

export type FormKeyCheck = { ok: true; keyId: string } | { ok: false; response: Response };

export async function checkFormKey(c: Context<AppEnv>): Promise<FormKeyCheck> {
  const { clientId, formId } = c.req.param() as { clientId: string; formId: string };
  const key = c.req.header("X-API-Key");

  const reject = (reason: string) => {
    logger.warn("rejected submission: invalid form key", { clientId, formId, reason });
    return { ok: false as const, response: errorResponse(c, 401, ErrorCode.UNAUTHORIZED, "Unauthorized") };
  };

  // Cheap rejections, without a call to sol-api.
  if (!key) return reject("missing");
  if (!key.startsWith(KEY_PREFIX)) return reject("malformed");

  let verification;
  try {
    verification = await verifyFormApiKey(c.env, clientId, formId, key);
  } catch (err) {
    // sol-api unreachable is our problem, not the caller's: 503, not 401.
    logger.error("couldn't verify form key", { clientId, formId, errorMessage: String(err) });
    return { ok: false, response: errorResponse(c, 503, ErrorCode.SERVICE_UNAVAILABLE, "Service unavailable") };
  }

  if (!verification.authenticated) return reject("not a key of this form");
  return { ok: true, keyId: verification.keyId };
}
