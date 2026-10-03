// Shared fetch for the three internal services Sol Gate calls — sol-api,
// sol-integrate and sol-notify — each through its own service binding, never
// a URL: a plain fetch() between Workers on the same workers.dev subdomain
// fails with Cloudflare "error code: 1042". The host in the URL is ignored
// by a binding; only the path matters.

import { traceHeaders } from "./log-context.js";

type ApiEnvelope<T> =
  | { success: true; data: T }
  | { success: false; error: { code: string; message: string; details?: unknown } };

export type ServiceName = "sol-api" | "sol-integrate" | "sol-notify";

export class ServiceError extends Error {
  constructor(
    public readonly service: ServiceName,
    /** HTTP status, or null when the service couldn't be reached at all (timeout, network). */
    public readonly status: number | null,
    message: string
  ) {
    super(`${service}${status === null ? "" : ` ${status}`}: ${message}`);
    this.name = "ServiceError";
  }

  // A 4xx other than 429 means the request itself was rejected (bad
  // contract, unknown template, missing client) — sending it again won't
  // change the answer. Everything else (5xx, 429, timeouts, network) is
  // worth retrying.
  get permanent(): boolean {
    return this.status !== null && this.status >= 400 && this.status < 500 && this.status !== 429;
  }
}

export interface ServiceFetchOptions {
  service: ServiceName;
  binding: Fetcher;
  apiKey: string;
  path: string;
  timeoutMs: number;
  init?: RequestInit;
}

export async function serviceFetch<T>(opts: ServiceFetchOptions): Promise<{ status: number; data: T }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);

  let response: Response;
  try {
    response = await opts.binding.fetch(`https://${opts.service}${opts.path}`, {
      ...opts.init,
      headers: {
        "X-API-Key": opts.apiKey,
        "Content-Type": "application/json",
        // So the service logs under the same trace and submission (SOL-46).
        ...traceHeaders(),
        ...opts.init?.headers,
      },
      signal: controller.signal,
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === "AbortError" ? `timed out after ${opts.timeoutMs}ms` : String(err);
    throw new ServiceError(opts.service, null, reason);
  } finally {
    clearTimeout(timeout);
  }

  // Read as text first so a non-JSON response (e.g. a Cloudflare error page
  // like "error code: 1042") surfaces with its status and body, rather than
  // as an opaque JSON SyntaxError.
  const text = await response.text();
  let body: ApiEnvelope<T>;
  try {
    body = JSON.parse(text) as ApiEnvelope<T>;
  } catch {
    throw new ServiceError(opts.service, response.status, `non-JSON response: ${text.slice(0, 200).trim()}`);
  }

  if (!response.ok || !body.success) {
    const message = body.success ? response.statusText : body.error.message;
    throw new ServiceError(opts.service, response.status, message);
  }

  return { status: response.status, data: body.data };
}
