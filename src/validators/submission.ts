import type { Context } from "hono";
import { z } from "zod";
import { errorResponse, validationErrorResponse } from "../lib/responses.js";
import { ErrorCode, type AppEnv } from "../types/index.js";

// The public submission body. Only `fields` (content) and the Turnstile
// token are read; anything else a caller sends (recipients, templates…) is
// dropped. `fields` is checked against the form's payload_schema separately.
export const submissionBodySchema = z.object({
  fields: z.record(z.string(), z.unknown()),
  turnstileToken: z.string().min(1).max(2048),
});

export type SubmissionBody = z.infer<typeof submissionBodySchema>;

const MAX_BODY_BYTES = 64 * 1024;

export type ParsedBody = { ok: true; body: SubmissionBody } | { ok: false; response: Response };

// Size (413), JSON and shape (422).
export async function parseSubmissionBody(c: Context<AppEnv>): Promise<ParsedBody> {
  const declaredLength = Number(c.req.header("Content-Length") ?? 0);
  const raw = declaredLength > MAX_BODY_BYTES ? null : await c.req.text();
  if (raw === null || raw.length > MAX_BODY_BYTES) {
    return { ok: false, response: errorResponse(c, 413, ErrorCode.PAYLOAD_TOO_LARGE, "Submission too large") };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, response: validationErrorResponse(c, "Body must be JSON") };
  }

  const parsed = submissionBodySchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, response: validationErrorResponse(c, "Validation failed", parsed.error.issues) };
  }
  return { ok: true, body: parsed.data };
}
