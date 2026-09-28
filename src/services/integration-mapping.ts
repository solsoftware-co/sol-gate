import { z } from "zod";
import { displayValue } from "../lib/payload-schema.js";
import type { IntegrationResult } from "../lib/sol-integrate.js";
import type { FormIntegration } from "../lib/sol-api.js";

// form_integrations.field_mapping → the `fields` sol-integrate expects for
// that integration type. Mapping is field → field: each value names a form
// field. Combining fields (one NAME = "first last") is deliberately not
// supported yet; see sol-brain/sol-api/03-scenario-form-01 (gap A).
//
// A mapping that can't produce a valid write resolves to `skipped` here,
// without calling sol-integrate: the form's configuration (or an optional
// field left empty) is the problem, not the integration.

export type MappingResult =
  | { ok: true; fields: Record<string, unknown> }
  | { ok: false; result: IntegrationResult };

// Mailchimp: { "email": "email", "mergeFields": { "FNAME": "firstName" } }.
// tags and statusIfNew are fixed per form, not taken from the submission.
const mailchimpMappingSchema = z.object({
  email: z.string().min(1),
  mergeFields: z.record(z.string(), z.string().min(1)).optional(),
  tags: z.array(z.string().min(1)).optional(),
  statusIfNew: z.enum(["subscribed", "pending"]).optional(),
});

function mapMailchimp(fieldMapping: unknown, fields: Record<string, unknown>): MappingResult {
  const mapping = mailchimpMappingSchema.safeParse(fieldMapping);
  if (!mapping.success) {
    return { ok: false, result: { outcome: "skipped", detail: "The form's Mailchimp field mapping is invalid" } };
  }

  const email = displayValue(fields[mapping.data.email])?.trim();
  if (!email) {
    return { ok: false, result: { outcome: "skipped", detail: "No email address was submitted" } };
  }

  const mergeFields: Record<string, string> = {};
  for (const [tag, field] of Object.entries(mapping.data.mergeFields ?? {})) {
    const value = displayValue(fields[field])?.trim();
    if (value) mergeFields[tag] = value;
  }

  return {
    ok: true,
    fields: {
      email,
      ...(Object.keys(mergeFields).length > 0 && { mergeFields }),
      ...(mapping.data.tags?.length && { tags: mapping.data.tags }),
      ...(mapping.data.statusIfNew && { statusIfNew: mapping.data.statusIfNew }),
    },
  };
}

export function mapIntegrationFields(integration: FormIntegration, fields: Record<string, unknown>): MappingResult {
  switch (integration.type) {
    case "mailchimp":
      return mapMailchimp(integration.fieldMapping, fields);
    // TODO(SOL-10): sol-integrate has no Google Sheets branch yet. Map
    // { "columns": [...] } into its row shape once that contract exists.
    case "google_sheets":
      return { ok: false, result: { outcome: "skipped", detail: "Google Sheets isn't supported yet" } };
    default:
      return { ok: false, result: { outcome: "skipped", detail: `Unsupported integration type: ${integration.type}` } };
  }
}

const TYPE_LABELS: Record<string, string> = { mailchimp: "Mailchimp", google_sheets: "Google Sheets" };

/** The name shown for an integration in a notification. */
export function integrationDisplayName(integration: Pick<FormIntegration, "name" | "type">): string {
  return integration.name ?? TYPE_LABELS[integration.type] ?? integration.type;
}
