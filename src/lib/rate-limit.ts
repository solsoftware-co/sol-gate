import type { Env } from "../types/index.js";

// Per client IP (across every form) and per form (across every IP). Both
// are Cloudflare rate-limiting bindings — see wrangler.toml for the limits.
export async function isRateLimited(
  env: Pick<Env, "IP_RATE_LIMITER" | "FORM_RATE_LIMITER">,
  ip: string,
  clientId: string,
  formId: string
): Promise<boolean> {
  const [byIp, byForm] = await Promise.all([
    env.IP_RATE_LIMITER.limit({ key: ip }),
    env.FORM_RATE_LIMITER.limit({ key: `${clientId}:${formId}` }),
  ]);
  return !byIp.success || !byForm.success;
}
