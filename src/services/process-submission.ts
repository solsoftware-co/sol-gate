import type { WorkflowStepConfig } from "cloudflare:workers";
import { logger } from "../lib/logger.js";
import { ServiceError } from "../lib/service-fetch.js";
import { listChannels, type Form, type SolApiEnv } from "../lib/sol-api.js";
import { runIntegration, type IntegrationResult, type SolIntegrateEnv } from "../lib/sol-integrate.js";
import { sendNotification, type SolNotifyEnv } from "../lib/sol-notify.js";
import { mapIntegrationFields } from "./integration-mapping.js";
import { buildNotification, type ResolvedChannel } from "./notifications.js";

// Everything after the 202: run the form's integrations, then notify every
// one of its channels — always, whether the integrations succeeded or not,
// each notification reporting only its own integrations' results.
//
// Runs inside a Cloudflare Workflow (workflows/submission.ts), one instance
// per submission. Each integration write and each notification is its own
// durable step: retried on its own, and never re-run once it has succeeded
// — so a retry can't write to Mailchimp twice or re-send an email that
// already went out. Code outside step.do() re-runs whenever the instance
// resumes, so it must stay deterministic (no I/O, no randomness).
//
// Written against this narrow Step interface, not WorkflowStep itself, so
// the whole flow is unit-testable with a fake step.

export interface Step {
  do<T>(name: string, config: WorkflowStepConfig, callback: () => Promise<T>): Promise<T>;
}

/** The form as it was when the submission was accepted — processing never reloads it. */
export type FormSnapshot = Pick<Form, "id" | "name" | "payloadSchema" | "integrations" | "channels">;

export interface SubmissionParams {
  submissionId: string;
  clientId: string;
  receivedAt: string;
  form: FormSnapshot;
  /** Already validated against form.payloadSchema. */
  fields: Record<string, unknown>;
}

export type ProcessEnv = SolApiEnv & SolIntegrateEnv & SolNotifyEnv;

export type NotificationStatus = "sent" | "failed" | "skipped";

export interface SubmissionSummary {
  submissionId: string;
  integrations: { integrationId: string; outcome: IntegrationResult["outcome"] }[];
  notifications: { channelId: string; status: NotificationStatus; detail?: string }[];
}

// sol-integrate answers 200 for every outcome, so a step only retries when
// sol-integrate itself couldn't be reached or crashed. Its own worst case
// is ≈20s per call.
const INTEGRATION_STEP: WorkflowStepConfig = {
  retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
  timeout: "2 minutes",
};
const RESOLVE_CHANNELS_STEP: WorkflowStepConfig = {
  retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
  timeout: "1 minute",
};
const NOTIFY_STEP: WorkflowStepConfig = {
  retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
  timeout: "1 minute",
};

export async function processSubmission(env: ProcessEnv, params: SubmissionParams, step: Step): Promise<SubmissionSummary> {
  const { submissionId, clientId, form, fields } = params;
  const context = { formId: form.id, submissionId };
  const log = { submissionId, clientId, formId: form.id };

  // 1. Integrations, in parallel.
  const results: Record<string, IntegrationResult> = {};
  await Promise.all(
    form.integrations.map(async (integration) => {
      const { integrationId, type } = integration;
      const mapped = mapIntegrationFields(integration, fields);
      if (!mapped.ok) {
        results[integrationId] = mapped.result;
        return;
      }
      try {
        results[integrationId] = await step.do(`integration ${integrationId}`, INTEGRATION_STEP, async () => {
          try {
            return await runIntegration(env, { clientId, type, integrationId, fields: mapped.fields, context });
          } catch (err) {
            // Rejected outright (e.g. a 422: the mapped fields don't fit its
            // contract) — retrying can't help. Anything else is thrown so
            // the step retries.
            if (err instanceof ServiceError && err.permanent) {
              logger.error("integration request rejected", { ...log, integrationId, type, errorMessage: err.message });
              return { outcome: "failed", detail: "Couldn't run this integration" } satisfies IntegrationResult;
            }
            throw err;
          }
        });
      } catch (err) {
        logger.error("integration step failed after retries", { ...log, integrationId, type, errorMessage: String(err) });
        results[integrationId] = { outcome: "failed", detail: "Couldn't reach the integration service" };
      }
    })
  );

  const summary: SubmissionSummary = {
    submissionId,
    integrations: form.integrations.map((i) => ({ integrationId: i.integrationId, outcome: results[i.integrationId].outcome })),
    notifications: [],
  };

  if (form.channels.length === 0) {
    logger.info("submission processed", { ...log, ...summary });
    return summary;
  }

  // 2. Resolve every channel in one call. Only email addresses are kept —
  // the response also carries Slack webhook URLs, which must never be
  // persisted in workflow state or forwarded (sol-notify looks them up).
  let resolved: ResolvedChannel[];
  try {
    resolved = await step.do("resolve channels", RESOLVE_CHANNELS_STEP, async () => {
      const channels = await listChannels(env, clientId, form.channels.map((c) => c.channelId));
      return channels.map((c) => ({ id: c.id, type: c.type, emailAddresses: c.email?.emailAddresses ?? [] }));
    });
  } catch (err) {
    logger.error("couldn't resolve channels", { ...log, errorMessage: String(err) });
    summary.notifications = form.channels.map((c) => ({
      channelId: c.channelId,
      status: "failed" as const,
      detail: "Couldn't resolve channels",
    }));
    logger.info("submission processed", { ...log, ...summary });
    return summary;
  }
  const byId = new Map(resolved.map((c) => [c.id, c]));

  // 3. One notification per channel, in parallel.
  summary.notifications = await Promise.all(
    form.channels.map(async (channel) => {
      const { channelId } = channel;
      const builtNotification = buildNotification({
        clientId,
        formName: form.name,
        payloadSchema: form.payloadSchema,
        context,
        fields,
        integrations: form.integrations,
        results,
        channel,
        resolved: byId.get(channelId),
      });
      if (!builtNotification.ok) {
        logger.warn("notification skipped", { ...log, channelId, reason: builtNotification.reason });
        return { channelId, status: "skipped" as const, detail: builtNotification.reason };
      }

      try {
        return await step.do(`notify ${channelId}`, NOTIFY_STEP, async () => {
          try {
            await sendNotification(env, builtNotification.request);
            return { channelId, status: "sent" as const };
          } catch (err) {
            // e.g. a 422 for a template or channel type sol-notify doesn't
            // support yet (SOL-34, SOL-13) — retrying can't help.
            if (err instanceof ServiceError && err.permanent) {
              logger.error("notification rejected", { ...log, channelId, type: channel.type, errorMessage: err.message });
              return { channelId, status: "failed" as const, detail: err.message };
            }
            throw err;
          }
        });
      } catch (err) {
        logger.error("notification step failed after retries", { ...log, channelId, errorMessage: String(err) });
        return { channelId, status: "failed" as const, detail: "Couldn't reach the notification service" };
      }
    })
  );

  logger.info("submission processed", { ...log, ...summary });
  return summary;
}
