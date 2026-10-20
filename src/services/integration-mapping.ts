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

// Google Sheets: the integration's own column_mapping (in sol-api) decides
// the sheet's columns and their order, so this only says which form field
// fills which column key. Either a list of form fields whose names are the
// column keys — { "columns": ["firstName", "email"] } — or, when a shared
// sheet's column keys differ from this form's field names, an object of
// column key → form field: { "columns": { "submitterEmail": "email" } }.
// sol-integrate fills the reserved `_timestamp` / `_submissionId` columns
// itself. Empty or missing fields are left out; their cells stay blank.
const googleSheetsMappingSchema = z.object({
  columns: z.union([
    z.array(z.string().min(1)).min(1),
    z.record(z.string().min(1), z.string().min(1)).refine((m) => Object.keys(m).length > 0),
  ]),
});

function mapGoogleSheets(fieldMapping: unknown, fields: Record<string, unknown>): MappingResult {
  const mapping = googleSheetsMappingSchema.safeParse(fieldMapping);
  if (!mapping.success) {
    return { ok: false, result: { outcome: "skipped", detail: "The form's Google Sheets field mapping is invalid" } };
  }

  const columns = Array.isArray(mapping.data.columns)
    ? mapping.data.columns.map((field) => [field, field] as const)
    : Object.entries(mapping.data.columns);

  const values: Record<string, string> = {};
  for (const [column, field] of columns) {
    const value = displayValue(fields[field])?.trim();
    if (value) values[column] = value;
  }

  return { ok: true, fields: { values } };
}

export function mapIntegrationFields(integration: FormIntegration, fields: Record<string, unknown>): MappingResult {
  switch (integration.type) {
    case "mailchimp":
      return mapMailchimp(integration.fieldMapping, fields);
    case "google_sheets":
      return mapGoogleSheets(integration.fieldMapping, fields);
    default:
      return { ok: false, result: { outcome: "skipped", detail: `Unsupported integration type: ${integration.type}` } };
  }
}

const TYPE_LABELS: Record<string, string> = { mailchimp: "Mailchimp", google_sheets: "Google Sheets" };

/** The service an integration writes to, e.g. "Mailchimp" — what a "View in …" button names. */
export function integrationTypeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type;
}

/** The name shown for an integration in a notification. */
export function integrationDisplayName(integration: Pick<FormIntegration, "name" | "type">): string {
  return integration.name ?? integrationTypeLabel(integration.type);
}
