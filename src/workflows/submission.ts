import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import { processSubmission, type Step, type SubmissionParams, type SubmissionSummary } from "../services/process-submission.js";
import type { Env } from "../types/index.js";

// One instance per accepted submission; the instance id is the
// submissionId, so an instance can be found in the dashboard (or with
// `wrangler workflows instances describe`) from any downstream log line.
// All of the logic lives in services/process-submission.ts.
export class SubmissionWorkflow extends WorkflowEntrypoint<Env, SubmissionParams> {
  async run(event: Readonly<WorkflowEvent<SubmissionParams>>, step: WorkflowStep): Promise<SubmissionSummary> {
    // Step results here are plain JSON objects, which is what WorkflowStep's
    // Rpc.Serializable constraint asks for; the casts only bridge the
    // generic signatures.
    const adapter: Step = {
      do: <T>(name: string, config: WorkflowStepConfig, callback: () => Promise<T>) =>
        step.do(name, config, callback as never) as Promise<T>,
    };
    return processSubmission(this.env, event.payload as SubmissionParams, adapter);
  }
}
