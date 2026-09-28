import { Hono, type Context } from "hono";
import { z } from "zod";
import { getForm, type Form } from "../lib/sol-api.js";
import { isAllowedOrigin } from "../lib/origin.js";
import { verifyTurnstile, TurnstileUnavailableError } from "../lib/turnstile.js";
import { validateFields } from "../lib/payload-schema.js";
import { errorResponse, forbiddenResponse, notFoundResponse, validationErrorResponse } from "../lib/responses.js";
import { logger } from "../lib/logger.js";
import type { SubmissionParams } from "../services/process-submission.js";
import { ErrorCode, type AppEnv } from "../types/index.js";

// The public front door: the only route in the stack that takes untrusted
// input. The website supplies only content (`fields`); what runs, who is
// notified and what they're told all come from the form's configuration in
// sol-api. A form id is public by design — together with its client id it
// only grants "submit to this form".

const submissions = new Hono<AppEnv>();

const PATH = "/:clientId/forms/:formId/submissions";
const MAX_BODY_BYTES = 64 * 1024;

const submissionBodySchema = z.object({
  fields: z.record(z.string(), z.unknown()),
  turnstileToken: z.string().min(1).max(2048),
});

// Per client IP (across every form) and per form (across every IP). Both
// are Cloudflare rate-limiting bindings — see wrangler.toml for the limits.
async function isRateLimited(c: Context<AppEnv>, clientId: string, formId: string): Promise<boolean> {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const [byIp, byForm] = await Promise.all([
    c.env.IP_RATE_LIMITER.limit({ key: ip }),
    c.env.FORM_RATE_LIMITER.limit({ key: `${clientId}:${formId}` }),
  ]);
  return !byIp.success || !byForm.success;
}

type FormLookup = { ok: true; form: Form; origin: string } | { ok: false; response: Response };

// Shared by the preflight and the POST: rate limit, load the form, check the
// Origin against its allowed_origins. On success, every later response
// carries CORS headers for that origin (so the browser can read a 422's
// details); failures never do.
async function lookUpForm(c: Context<AppEnv>): Promise<FormLookup> {
  const { clientId, formId } = c.req.param() as { clientId: string; formId: string };

  if (await isRateLimited(c, clientId, formId)) {
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

submissions.options(PATH, async (c) => {
  const lookup = await lookUpForm(c);
  if (!lookup.ok) return lookup.response;
  c.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type");
  c.header("Access-Control-Max-Age", "600");
  return c.body(null, 204);
});

submissions.post(PATH, async (c) => {
  const lookup = await lookUpForm(c);
  if (!lookup.ok) return lookup.response;
  const { form } = lookup;
  const requestId = c.get("requestId");

  const declaredLength = Number(c.req.header("Content-Length") ?? 0);
  const raw = declaredLength > MAX_BODY_BYTES ? null : await c.req.text();
  if (raw === null || raw.length > MAX_BODY_BYTES) {
    return errorResponse(c, 413, ErrorCode.PAYLOAD_TOO_LARGE, "Submission too large");
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return validationErrorResponse(c, "Body must be JSON");
  }
  const body = submissionBodySchema.safeParse(json);
  if (!body.success) return validationErrorResponse(c, "Validation failed", body.error.issues);

  try {
    const turnstile = await verifyTurnstile(c.env.TURNSTILE_SECRET_KEY, body.data.turnstileToken, {
      remoteIp: c.req.header("CF-Connecting-IP"),
    });
    if (!turnstile.success) {
      logger.warn("rejected submission: turnstile failed", {
        requestId,
        clientId: form.clientId,
        formId: form.id,
        errorCodes: turnstile.errorCodes,
      });
      return forbiddenResponse(c, "Turnstile verification failed");
    }
  } catch (err) {
    if (!(err instanceof TurnstileUnavailableError)) throw err;
    logger.error("turnstile unavailable", { requestId, formId: form.id, errorMessage: err.message });
    return errorResponse(c, 503, ErrorCode.SERVICE_UNAVAILABLE, "Service unavailable");
  }

  // An unusable payload_schema throws → 500: the form is misconfigured, and
  // the submitter can't fix that.
  const fieldErrors = validateFields(form.payloadSchema, body.data.fields);
  if (fieldErrors.length > 0) return validationErrorResponse(c, "Invalid fields", fieldErrors);

  const submissionId = crypto.randomUUID();
  const params: SubmissionParams = {
    submissionId,
    clientId: form.clientId,
    receivedAt: new Date().toISOString(),
    form: {
      id: form.id,
      name: form.name,
      payloadSchema: form.payloadSchema,
      integrations: form.integrations,
      channels: form.channels,
    },
    fields: body.data.fields,
  };
  await c.env.SUBMISSION_WORKFLOW.create({ id: submissionId, params });

  logger.info("submission accepted", {
    requestId,
    submissionId,
    clientId: form.clientId,
    formId: form.id,
    integrations: form.integrations.length,
    channels: form.channels.length,
  });

  return c.json({ success: true, data: { submissionId } }, 202);
});

export default submissions;
