import { Hono } from "hono";
import { checkFormKey } from "../lib/form-key.js";
import { lookUpForm } from "../lib/form-lookup.js";
import { validateFields } from "../lib/payload-schema.js";
import { validationErrorResponse } from "../lib/responses.js";
import { logger } from "../lib/logger.js";
import { parseSubmissionBody } from "../validators/submission.js";
import type { SubmissionParams } from "../services/process-submission.js";
import type { AppEnv } from "../types/index.js";

// The front door: the only route in the stack that takes untrusted input.
// Callers are servers, e.g. a client's Next.js Server Action relaying its own
// form, authenticated with a key of this form (lib/form-key.ts).
// They supply only content (`fields`); what runs, who is notified and what
// they're told all come from the form's configuration in sol-api.

const submissions = new Hono<AppEnv>();

const PATH = "/:clientId/forms/:formId/submissions";

submissions.post(PATH, async (c) => {
  // The key first: an unauthenticated request must not use up the form's
  // rate limit, or anyone could block a form's real submissions.
  const auth = await checkFormKey(c);
  if (!auth.ok) return auth.response;

  const lookup = await lookUpForm(c);
  if (!lookup.ok) return lookup.response;
  const { form } = lookup;
  const requestId = c.get("requestId");

  const parsed = await parseSubmissionBody(c);
  if (!parsed.ok) return parsed.response;
  const { body } = parsed;

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
    // The matched form key's id. Not named keyId: the logger redacts any
    // field whose name contains "key".
    credentialId: auth.keyId,
    integrations: form.integrations.length,
    channels: form.channels.length,
  });

  return c.json({ success: true, data: { submissionId } }, 202);
});

export default submissions;
