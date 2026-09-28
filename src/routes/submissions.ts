import { Hono } from "hono";
import { lookUpForm } from "../lib/form-lookup.js";
import { verifyTurnstile, TurnstileUnavailableError } from "../lib/turnstile.js";
import { validateFields } from "../lib/payload-schema.js";
import { errorResponse, forbiddenResponse, validationErrorResponse } from "../lib/responses.js";
import { logger } from "../lib/logger.js";
import { parseSubmissionBody } from "../validators/submission.js";
import type { SubmissionParams } from "../services/process-submission.js";
import { ErrorCode, type AppEnv } from "../types/index.js";

// The public front door: the only route in the stack that takes untrusted
// input. The website supplies only content (`fields`); what runs, who is
// notified and what they're told all come from the form's configuration in
// sol-api. A form id is public by design — together with its client id it
// only grants "submit to this form".

const submissions = new Hono<AppEnv>();

const PATH = "/:clientId/forms/:formId/submissions";

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

  const parsed = await parseSubmissionBody(c);
  if (!parsed.ok) return parsed.response;
  const { body } = parsed;

  try {
    const turnstile = await verifyTurnstile(c.env.TURNSTILE_SECRET_KEY, body.turnstileToken, {
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
  const fieldErrors = validateFields(form.payloadSchema, body.fields);
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
    fields: body.fields,
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
