import { serviceFetch } from "./service-fetch.js";

// sol-integrate performs one integration write and returns its outcome —
// 200 for every outcome, since a failed write is a result to report, not a
// broken request (SOL-33). Its own worst case is ≈20s (2 attempts × member
// PUT + tags × 5s), so this timeout sits just above that.
const FETCH_TIMEOUT_MS = 30_000;

export interface SolIntegrateEnv {
  SOL_INTEGRATE: Fetcher;
  SOL_INTEGRATE_API_KEY: string;
}

export type IntegrationOutcome = "succeeded" | "failed" | "skipped";

export interface IntegrationResult {
  outcome: IntegrationOutcome;
  /** Where to see the result (e.g. the Mailchimp member page). */
  url?: string;
  /** Short and client-readable — it ends up in the form_submission email. */
  detail?: string;
}

export interface SubmissionContext {
  formId: string;
  submissionId: string;
}

export interface IntegrationWriteRequest {
  clientId: string;
  type: string;
  integrationId: string;
  /** Already mapped into the integration's shape (services/integration-mapping.ts). */
  fields: Record<string, unknown>;
  context: SubmissionContext;
}

export async function runIntegration(env: SolIntegrateEnv, request: IntegrationWriteRequest): Promise<IntegrationResult> {
  const { data } = await serviceFetch<IntegrationResult & Record<string, unknown>>({
    service: "sol-integrate",
    binding: env.SOL_INTEGRATE,
    apiKey: env.SOL_INTEGRATE_API_KEY,
    path: "/",
    timeoutMs: FETCH_TIMEOUT_MS,
    init: { method: "POST", body: JSON.stringify(request) },
  });
  // Keep only what's reported onward — e.g. drop Mailchimp's memberId.
  return {
    outcome: data.outcome,
    ...(data.url && { url: data.url }),
    ...(data.detail && { detail: data.detail }),
  };
}
