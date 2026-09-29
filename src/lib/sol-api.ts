import { serviceFetch, ServiceError } from "./service-fetch.js";

// sol-api holds every piece of configuration Sol Gate acts on (SOL-35 schema,
// SOL-36 endpoints). These types mirror sol-api's services/forms.ts and
// services/channels.ts responses.

const FETCH_TIMEOUT_MS = 10_000;

export interface SolApiEnv {
  SOL_API: Fetcher;
  SOL_API_KEY: string;
}

export interface FormIntegration {
  integrationId: string;
  type: string;
  name: string | null;
  status: string;
  /** Maps the form's fields onto this integration's shape — see services/integration-mapping.ts. */
  fieldMapping: Record<string, unknown>;
}

export interface FormChannel {
  channelId: string;
  type: "email" | "slack";
  name: string;
  template: string;
  subject: string | null;
  /** NULL = every submitted field; [] = none. */
  includeFields: string[] | null;
  /** Fixed text (Slack). No substitution. */
  message: string | null;
  /** Which of the form's integrations this notification reports on. Opt-in: empty means none. */
  integrationIds: string[];
}

export interface Form {
  id: string;
  clientId: string;
  name: string;
  description: string | null;
  /** JSON Schema for the submission's `fields`. */
  payloadSchema: Record<string, unknown>;
  allowedOrigins: string[];
  createdAt: string;
  updatedAt: string;
  integrations: FormIntegration[];
  channels: FormChannel[];
}

export interface Channel {
  id: string;
  clientId: string;
  type: "email" | "slack";
  name: string;
  description: string | null;
  email?: { emailAddresses: string[] } | null;
  /** Returned by sol-api, but never forwarded or stored: sol-notify looks webhooks up itself. */
  slack?: { webhookUrl: string } | null;
}

// Client-scoped: a form id under the wrong client (or a non-UUID id) is a
// 404 from sol-api, returned here as null.
export async function getForm(env: SolApiEnv, clientId: string, formId: string): Promise<Form | null> {
  try {
    const { data } = await serviceFetch<Form>({
      service: "sol-api",
      binding: env.SOL_API,
      apiKey: env.SOL_API_KEY,
      path: `/v1/clients/${encodeURIComponent(clientId)}/forms/${encodeURIComponent(formId)}`,
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    return data;
  } catch (err) {
    if (err instanceof ServiceError && err.status === 404) return null;
    throw err;
  }
}

// Resolves channel ids to what's needed to deliver to them, in one call.
// Unknown or other-client ids are simply absent from the result.
export async function listChannels(env: SolApiEnv, clientId: string, ids: string[]): Promise<Channel[]> {
  if (ids.length === 0) return [];
  const { data } = await serviceFetch<Channel[]>({
    service: "sol-api",
    binding: env.SOL_API,
    apiKey: env.SOL_API_KEY,
    path: `/v1/clients/${encodeURIComponent(clientId)}/channels?ids=${ids.map(encodeURIComponent).join(",")}`,
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  return data;
}
