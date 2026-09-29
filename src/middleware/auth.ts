import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../types/index.js";
import { logger } from "../lib/logger.js";

// Every caller is a server (e.g. a client's Next.js Server Action or Route
// Handler) that keeps the key secret — a key embedded in browser code would
// be public, so browsers must never call Sol Gate directly. One key per
// environment for now; per-form keys (a hash on the forms row in sol-api)
// are a later change.
export const requireApiKey = createMiddleware<AppEnv>(async (c, next) => {
  const key = c.req.header("X-API-Key");
  if (!key || !(await keysMatch(key, c.env.API_KEY))) {
    logger.warn("rejected request: invalid or missing API key", {
      requestId: c.get("requestId"),
      path: c.req.path,
      method: c.req.method,
      credentialPresent: Boolean(key),
    });
    throw new HTTPException(401, { message: "Unauthorized" });
  }
  await next();
});

// Constant-time comparison. Hashing first gives both sides the same length,
// which timingSafeEqual requires, without leaking the real key's length.
async function keysMatch(given: string, expected: string | undefined): Promise<boolean> {
  if (!expected) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(given)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return (crypto.subtle as WorkersSubtleCrypto).timingSafeEqual(a, b);
}

// Workers-only (non-standard) API, missing from the DOM typings tsconfig
// also loads.
type WorkersSubtleCrypto = SubtleCrypto & { timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean };
