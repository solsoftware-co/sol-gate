import { displayValue } from "../lib/payload-schema.js";
import type { FormChannel, FormIntegration } from "../lib/sol-api.js";
import type { IntegrationResult, SubmissionContext } from "../lib/sol-integrate.js";
import type { NotificationIntegrationResult, NotificationRequest } from "../lib/sol-notify.js";
import { integrationDisplayName } from "./integration-mapping.js";

// Builds one form channel's notification — pure, so the Form 01 scenario
// can be checked without any services. Each channel on a form gets its own
// notification, from its own form_channels row: its subject, its fields
// (include_fields) and only the integrations it reports on
// (form_channel_integrations → integrationIds).

/** What the workflow keeps from sol-api's channel lookup: never a Slack webhook. */
export interface ResolvedChannel {
  id: string;
  type: "email" | "slack";
  emailAddresses: string[];
}

export interface NotificationInput {
  clientId: string;
  formName: string;
  payloadSchema: Record<string, unknown>;
  context: SubmissionContext;
  fields: Record<string, unknown>;
  integrations: FormIntegration[];
  /** Keyed by integrationId. */
  results: Record<string, IntegrationResult>;
  channel: FormChannel;
  /** Undefined when sol-api no longer has the channel. */
  resolved: ResolvedChannel | undefined;
}

export type BuiltNotification = { ok: true; request: NotificationRequest } | { ok: false; reason: string };

export function buildNotification(input: NotificationInput): BuiltNotification {
  const { channel, resolved, context } = input;
  if (!resolved || resolved.type !== channel.type) return { ok: false, reason: "Channel not found" };

  const base = {
    clientId: input.clientId,
    context,
    idempotencyKey: `${context.submissionId}:${channel.channelId}`,
  };

  if (channel.type === "slack") {
    if (!channel.message) return { ok: false, reason: "No message configured for this Slack channel" };
    return { ok: true, request: { ...base, type: "slack", slackChannelId: channel.channelId, text: channel.message } };
  }

  if (resolved.emailAddresses.length === 0) return { ok: false, reason: "Email group has no addresses" };

  const integrations = reportedIntegrations(input.integrations, channel.integrationIds, input.results);
  const cta = replyCta(input.fields, input.payloadSchema);

  return {
    ok: true,
    request: {
      ...base,
      type: "email",
      recipients: resolved.emailAddresses,
      subject: channel.subject ?? `New submission: ${input.formName}`,
      emailTemplate: channel.template,
      fields: {
        submission: includedFields(input.fields, channel.includeFields),
        ...(integrations.length > 0 && { integrations }),
      },
      ...(cta && { cta }),
    },
  };
}

// include_fields: NULL = every submitted field (in submitted order);
// [] = none; otherwise the listed fields, in listed order, when submitted.
export function includedFields(fields: Record<string, unknown>, includeFields: string[] | null): Record<string, string> {
  const keys = includeFields ?? Object.keys(fields);
  const result: Record<string, string> = {};
  for (const key of keys) {
    if (!Object.hasOwn(fields, key)) continue;
    const value = displayValue(fields[key]);
    if (value !== null) result[key] = value;
  }
  return result;
}

// Opt-in: only the integrations this channel reports on, in the form's
// integration order. Empty integrationIds = no results at all.
function reportedIntegrations(
  integrations: FormIntegration[],
  integrationIds: string[],
  results: Record<string, IntegrationResult>
): NotificationIntegrationResult[] {
  const wanted = new Set(integrationIds);
  return integrations
    .filter((i) => wanted.has(i.integrationId) && results[i.integrationId])
    .map((i) => ({ name: integrationDisplayName(i), ...results[i.integrationId] }));
}

const EMAIL_PATTERN = /^[^\s@?&#]+@[^\s@?&#]+\.[^\s@?&#]+$/;
const EMAIL_FIELD_NAME = /^e-?mail(_?address)?$/i;

// "Reply to {name}" when the form has an email field: the first property
// the payload schema declares as `format: "email"`, else a field named like
// "email". Only a plausible address becomes a mailto: link.
export function replyCta(
  fields: Record<string, unknown>,
  payloadSchema: Record<string, unknown>
): { url: string; label: string } | undefined {
  const properties = (payloadSchema.properties ?? {}) as Record<string, { format?: unknown } | undefined>;
  const emailKey =
    Object.keys(properties).find((k) => properties[k]?.format === "email" && Object.hasOwn(fields, k)) ??
    Object.keys(fields).find((k) => EMAIL_FIELD_NAME.test(k));
  if (!emailKey) return undefined;

  const email = displayValue(fields[emailKey])?.trim();
  if (!email || !EMAIL_PATTERN.test(email)) return undefined;

  const name = submitterName(fields);
  return { url: `mailto:${email}`, label: name ? `Reply to ${name}` : "Reply" };
}

function submitterName(fields: Record<string, unknown>): string | null {
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = displayValue(fields[key])?.trim();
      if (value) return value;
    }
    return null;
  };
  return pick("name", "fullName", "full_name") ?? pick("firstName", "first_name");
}
