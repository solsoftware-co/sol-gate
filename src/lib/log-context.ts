import { AsyncLocalStorage } from "node:async_hooks";

// Fields every log line carries without each call passing them (SOL-46):
// - environment: the Worker's ENVIRONMENT, so Workers Observability can
//   filter by it.
// - traceId: one run of work, followed across sol-gate, sol-integrate,
//   sol-notify and sol-api. Every log line has one.
// - submissionId: the form submission the work is for, assigned by Sol Gate.
//   Only on lines that are for a submission. A replayed submission would keep
//   its submissionId under a new traceId.
// Both ids travel between services as TRACE_ID_HEADER / SUBMISSION_ID_HEADER.
//
// Sol Gate starts every trace: it generates a traceId per request and a
// submissionId per submission, never taking either from its (public) caller.
// Set in index.ts (environment, traceId), routes/submissions.ts
// (submissionId) and workflows/submission.ts (a run's own scope);
// AsyncLocalStorage carries them through every await, step and waitUntil
// below that, and serviceFetch() forwards them.
export interface LogScope {
  environment?: string;
  traceId?: string;
  submissionId?: string;
}

export const TRACE_ID_HEADER = "X-Trace-Id";
export const SUBMISSION_ID_HEADER = "X-Submission-Id";

const storage = new AsyncLocalStorage<LogScope>();

/** Runs `fn` with `scope` added to the current one. */
export function withLogScope<T>(scope: LogScope, fn: () => T): T {
  return storage.run({ ...currentLogScope(), ...scope }, fn);
}

export function currentLogScope(): LogScope {
  return storage.getStore() ?? {};
}

/** The current trace and submission ids, as headers for a call to another internal service. */
export function traceHeaders(): Record<string, string> {
  const { traceId, submissionId } = currentLogScope();
  return {
    ...(traceId && { [TRACE_ID_HEADER]: traceId }),
    ...(submissionId && { [SUBMISSION_ID_HEADER]: submissionId }),
  };
}
