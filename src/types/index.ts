import type { SubmissionParams } from "../services/process-submission.js";

export interface Env {
  ENVIRONMENT: string;
  /** sol-api, sol-integrate and sol-notify are reached only through service bindings — see wrangler.toml. */
  SOL_API: Fetcher;
  SOL_API_KEY: string;
  SOL_INTEGRATE: Fetcher;
  SOL_INTEGRATE_API_KEY: string;
  SOL_NOTIFY: Fetcher;
  SOL_NOTIFY_API_KEY: string;
  /** Rate-limiting binding, per form. */
  FORM_RATE_LIMITER: RateLimit;
  /** One instance per accepted submission (instance id = submissionId). */
  SUBMISSION_WORKFLOW: Workflow<SubmissionParams>;
  /** Released package.json version, injected at deploy time by CI (release.yml). Unset locally. */
  APP_VERSION?: string;
}

export type AppEnv = {
  Bindings: Env;
  /** traceId: every request (index.ts). submissionId: set as soon as a submission arrives (routes/submissions.ts). */
  Variables: { traceId: string; submissionId: string };
};

export enum ErrorCode {
  UNAUTHORIZED = "UNAUTHORIZED",
  NOT_FOUND = "NOT_FOUND",
  PAYLOAD_TOO_LARGE = "PAYLOAD_TOO_LARGE",
  VALIDATION_ERROR = "VALIDATION_ERROR",
  RATE_LIMITED = "RATE_LIMITED",
  INTERNAL_ERROR = "INTERNAL_ERROR",
  SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE",
}

export type ApiResponse<T> =
  | { success: true; data: T }
  | { success: false; error: { code: ErrorCode; message: string; details?: unknown } };
