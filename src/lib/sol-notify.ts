import { serviceFetch } from "./service-fetch.js";
import type { IntegrationOutcome, SubmissionContext } from "./sol-integrate.js";

// sol-notify's notification.requested contract, as Sol Gate sends it. It
// answers 202 once a request is accepted and sends in the background, so
// this call is quick.
//
// Parts of this contract are ahead of sol-notify (as of v1.2.0): the
// `form_submission` template is SOL-34, `type: "slack"` is SOL-13, and
// `context` / `idempotencyKey` are SOL-37. Until those land, sol-notify
// 422s the first two (recorded as a failed notification, not retried) and
// silently ignores the last two.
const FETCH_TIMEOUT_MS = 15_000;

export interface SolNotifyEnv {
  SOL_NOTIFY: Fetcher;
  SOL_NOTIFY_API_KEY: string;
}

export interface NotificationIntegrationResult {
  name: string;
  outcome: IntegrationOutcome;
  url?: string;
  detail?: string;
}

interface NotificationBase {
  clientId: string;
  context: SubmissionContext;
  /** `submissionId:channelId` — lets sol-notify drop a retried duplicate (SOL-37). */
  idempotencyKey: string;
}

export interface EmailNotificationRequest extends NotificationBase {
  type: "email";
  recipients: string[];
  subject: string;
  emailTemplate: string;
  /** `form_submission`'s fields (SOL-34). */
  fields: {
    submission: Record<string, string>;
    integrations?: NotificationIntegrationResult[];
  };
  cta?: { url: string; label?: string };
}

export interface SlackNotificationRequest extends NotificationBase {
  type: "slack";
  /** The `channels.id` — sol-notify looks the webhook up in sol-api itself. A webhook URL never travels in a request. */
  slackChannelId: string;
  text: string;
}

export type NotificationRequest = EmailNotificationRequest | SlackNotificationRequest;

export async function sendNotification(env: SolNotifyEnv, request: NotificationRequest): Promise<void> {
  await serviceFetch<unknown>({
    service: "sol-notify",
    binding: env.SOL_NOTIFY,
    apiKey: env.SOL_NOTIFY_API_KEY,
    path: "/",
    timeoutMs: FETCH_TIMEOUT_MS,
    init: { method: "POST", body: JSON.stringify(request) },
  });
}
