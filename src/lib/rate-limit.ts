import type { Env } from "../types/index.js";

// Per form, across every caller — a Cloudflare rate-limiting binding (see
// wrangler.toml for the limit). There's no per-IP limit: callers are
// servers, so Sol Gate only sees the calling server's IP, not the visitor's.
export async function isRateLimited(
  env: Pick<Env, "FORM_RATE_LIMITER">,
  clientId: string,
  formId: string
): Promise<boolean> {
  const { success } = await env.FORM_RATE_LIMITER.limit({ key: `${clientId}:${formId}` });
  return !success;
}
