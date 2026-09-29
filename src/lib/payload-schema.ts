import { Validator, type OutputUnit } from "@cfworker/json-schema";

// forms.payload_schema is a JSON Schema for the submission's `fields`. Ajv
// can't run on Workers (it compiles validators with `new Function`), so this
// uses @cfworker/json-schema, which interprets the schema instead.

export interface FieldError {
  /** JSON Pointer into `fields`, e.g. "/email"; "" for the object itself. */
  path: string;
  message: string;
}

// Dropped so the details list the actual problems: errors that only
// summarize their children's ("Property \"tags\" does not match schema"),
// and the bare "False boolean schema." under additionalProperties: false
// (its additionalProperties error names the property, so that one stays).
const UNHELPFUL_KEYWORDS = new Set(["properties", "allOf", "anyOf", "oneOf", "$ref", "items", "prefixItems", "false"]);

// Throws on a schema it can't use (e.g. an unresolvable $ref) — the form is
// misconfigured, which the route leaves to the global error handler (500).
export function validateFields(schema: Record<string, unknown>, fields: unknown): FieldError[] {
  const result = new Validator(schema as never, "2020-12", false).validate(fields);
  if (result.valid) return [];

  const leaves = result.errors.filter((e) => !UNHELPFUL_KEYWORDS.has(e.keyword));
  const errors = leaves.length > 0 ? leaves : result.errors;
  return dedupe(errors.map((e: OutputUnit) => ({ path: e.instanceLocation.replace(/^#/, ""), message: e.error })));
}

function dedupe(errors: FieldError[]): FieldError[] {
  const seen = new Set<string>();
  return errors.filter((e) => {
    const key = `${e.path}\u0000${e.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Submitted values are JSON of whatever shape the schema allows; everything
// downstream (Mailchimp merge fields, email rows) wants a string.
export function displayValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((v) => displayValue(v) ?? "").join(", ");
  return JSON.stringify(value);
}
