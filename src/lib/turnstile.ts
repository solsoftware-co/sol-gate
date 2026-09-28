// Cloudflare Turnstile server-side check. Tokens are single-use and expire
// after 5 minutes. Locally, .dev.vars uses Cloudflare's documented test
// secret (1x0000000000000000000000000000000AA — every token passes), so
// there's no environment-specific bypass in code.

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const FETCH_TIMEOUT_MS = 5_000;

export class TurnstileUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnstileUnavailableError";
  }
}

export interface TurnstileResult {
  success: boolean;
  errorCodes: string[];
}

export async function verifyTurnstile(
  secret: string,
  token: string,
  opts: { remoteIp?: string; idempotencyKey?: string } = {}
): Promise<TurnstileResult> {
  const body = new FormData();
  body.append("secret", secret);
  body.append("response", token);
  if (opts.remoteIp) body.append("remoteip", opts.remoteIp);
  if (opts.idempotencyKey) body.append("idempotency_key", opts.idempotencyKey);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(SITEVERIFY_URL, { method: "POST", body, signal: controller.signal });
  } catch (err) {
    throw new TurnstileUnavailableError(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timeout);
  }

  const result = (await response.json().catch(() => null)) as { success?: boolean; "error-codes"?: string[] } | null;
  if (!response.ok || !result) {
    throw new TurnstileUnavailableError(`siteverify returned HTTP ${response.status}`);
  }
  return { success: result.success === true, errorCodes: result["error-codes"] ?? [] };
}
