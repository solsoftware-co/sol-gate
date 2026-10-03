import { describe, it, expect, beforeEach, vi } from "vitest";
import { processSubmission, stepInLogScope, type Step, type SubmissionParams } from "../../../src/services/process-submission.js";
import { withLogScope, currentLogScope } from "../../../src/lib/log-context.js";
import {
  CLIENT_ID,
  FORM_ID,
  GROUP_01_ID,
  GROUP_02_ID,
  LEADS_SHEET_ID,
  LEADS_SLACK_ID,
  NEWSLETTER_ID,
  form01,
  form01Channels,
  submission,
} from "../fixtures/form-01.js";

type Handler = (path: string, body: unknown) => Response | Promise<Response>;

interface Recorded {
  path: string;
  body: any;
  apiKey: string | null;
  /** The X-Trace-Id and X-Submission-Id headers. */
  traceIdHeader: string | null;
  submissionIdHeader: string | null;
}

function fakeService(handler: Handler) {
  const calls: Recorded[] = [];
  const fetcher = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      const headers = new Headers(init?.headers);
      calls.push({
        path: url.pathname + url.search,
        body,
        apiKey: headers.get("X-API-Key"),
        traceIdHeader: headers.get("X-Trace-Id"),
        submissionIdHeader: headers.get("X-Submission-Id"),
      });
      return handler(url.pathname + url.search, body);
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

// Runs each callback once; a throw propagates, as if the step's retries
// were exhausted.
function fakeStep() {
  const names: string[] = [];
  const outputs: unknown[] = [];
  const step: Step = {
    do: async (name, _config, callback) => {
      names.push(name);
      const output = await callback();
      outputs.push(output);
      return output;
    },
  };
  return { step, names, outputs };
}

const ok = (data: unknown, status = 200) => Response.json({ success: true, data }, { status });
const fail = (status: number, message: string) =>
  Response.json({ success: false, error: { code: "X", message } }, { status });

const SUBMISSION_ID = "sub-0001";
const params: SubmissionParams = {
  submissionId: SUBMISSION_ID,
  clientId: CLIENT_ID,
  receivedAt: "2026-09-28T12:00:00.000Z",
  form: form01,
  fields: submission,
};

let solApi: ReturnType<typeof fakeService>;
let solIntegrate: ReturnType<typeof fakeService>;
let solNotify: ReturnType<typeof fakeService>;

function env() {
  return {
    SOL_API: solApi.fetcher,
    SOL_API_KEY: "api-key",
    SOL_INTEGRATE: solIntegrate.fetcher,
    SOL_INTEGRATE_API_KEY: "integrate-key",
    SOL_NOTIFY: solNotify.fetcher,
    SOL_NOTIFY_API_KEY: "notify-key",
  };
}

const notificationFor = (channelId: string) => solNotify.calls.find((c) => c.body.idempotencyKey.endsWith(channelId))?.body;

beforeEach(() => {
  solApi = fakeService(() => ok(form01Channels));
  solIntegrate = fakeService(() =>
    ok({ outcome: "succeeded", url: "https://us21.admin.mailchimp.com/lists/members/view?id=7", memberId: "m-1" })
  );
  solNotify = fakeService(() => ok({ accepted: true }, 202));
});

describe("processSubmission — Form 01", () => {
  it("runs the Mailchimp write with the mapped fields and the submission's context", async () => {
    const { step } = fakeStep();
    await processSubmission(env(), params, step);

    expect(solIntegrate.calls).toHaveLength(1);
    expect(solIntegrate.calls[0]).toEqual({
      path: "/",
      apiKey: "integrate-key",
      traceIdHeader: null, // run outside a log scope here; see the SOL-46 tests below
      submissionIdHeader: null,
      body: {
        clientId: CLIENT_ID,
        type: "mailchimp",
        integrationId: NEWSLETTER_ID,
        fields: { email: "jane@example.com", mergeFields: { FNAME: "Jane", LNAME: "Doe" } },
        context: { formId: FORM_ID, submissionId: SUBMISSION_ID },
      },
    });
  });

  it("resolves all three channels in one sol-api call", async () => {
    const { step } = fakeStep();
    await processSubmission(env(), params, step);

    expect(solApi.calls).toHaveLength(1);
    expect(solApi.calls[0].path).toBe(`/v1/clients/acme/channels?ids=${GROUP_01_ID},${GROUP_02_ID},${LEADS_SLACK_ID}`);
  });

  it("sends group 01 its 3 fields and the Newsletter result only", async () => {
    const { step } = fakeStep();
    await processSubmission(env(), params, step);

    expect(notificationFor(GROUP_01_ID)).toEqual({
      clientId: CLIENT_ID,
      type: "email",
      recipients: ["g1@acme.test"],
      subject: "New Mailchimp subscriber",
      emailTemplate: "form_submission",
      fields: {
        submission: { firstName: "Jane", lastName: "Doe", email: "jane@example.com" },
        integrations: [
          { name: "Newsletter", typeLabel: "Mailchimp", outcome: "succeeded", url: "https://us21.admin.mailchimp.com/lists/members/view?id=7" },
        ],
      },
      cta: { url: "mailto:jane@example.com", label: "Reply to Jane" },
      context: { formId: FORM_ID, submissionId: SUBMISSION_ID },
      idempotencyKey: `${SUBMISSION_ID}:${GROUP_01_ID}`,
    });
  });

  it("sends group 02 all 6 fields and both results, in the form's integration order", async () => {
    const { step } = fakeStep();
    await processSubmission(env(), params, step);

    const request = notificationFor(GROUP_02_ID);
    expect(request.subject).toBe("Form 01 submission");
    expect(request.recipients).toEqual(["g2@acme.test"]);
    expect(request.fields.submission).toEqual(submission);
    expect(request.fields.integrations).toEqual([
      { name: "Newsletter", typeLabel: "Mailchimp", outcome: "succeeded", url: "https://us21.admin.mailchimp.com/lists/members/view?id=7" },
      { name: "Leads sheet", typeLabel: "Google Sheets", outcome: "skipped", detail: "Google Sheets isn't supported yet" },
    ]);
  });

  it("sends #leads its fixed Slack message by channel id, with no integration results", async () => {
    const { step } = fakeStep();
    await processSubmission(env(), params, step);

    expect(notificationFor(LEADS_SLACK_ID)).toEqual({
      clientId: CLIENT_ID,
      type: "slack",
      slackChannelId: LEADS_SLACK_ID,
      text: "form 01 just ran successfully!",
      context: { formId: FORM_ID, submissionId: SUBMISSION_ID },
      idempotencyKey: `${SUBMISSION_ID}:${LEADS_SLACK_ID}`,
    });
  });

  it("never forwards or stores the Slack webhook", async () => {
    const { step, outputs } = fakeStep();
    const summary = await processSubmission(env(), params, step);

    const everything = JSON.stringify({ requests: solNotify.calls, outputs, summary });
    expect(everything).not.toContain("SECRETWEBHOOK");
  });

  it("uses one deterministic, unique step name per integration write and notification", async () => {
    const { step, names } = fakeStep();
    await processSubmission(env(), params, step);

    expect([...names].sort()).toEqual(
      [
        `integration ${NEWSLETTER_ID}`,
        "resolve channels",
        `notify ${GROUP_01_ID}`,
        `notify ${GROUP_02_ID}`,
        `notify ${LEADS_SLACK_ID}`,
      ].sort()
    );
  });

  it("returns a summary with no submitted field values", async () => {
    const { step } = fakeStep();
    const summary = await processSubmission(env(), params, step);

    expect(summary).toEqual({
      submissionId: SUBMISSION_ID,
      integrations: [
        { integrationId: NEWSLETTER_ID, outcome: "succeeded" },
        { integrationId: LEADS_SHEET_ID, outcome: "skipped" },
      ],
      notifications: [
        { channelId: GROUP_01_ID, status: "sent" },
        { channelId: GROUP_02_ID, status: "sent" },
        { channelId: LEADS_SLACK_ID, status: "sent" },
      ],
    });
    expect(JSON.stringify(summary)).not.toContain("jane@example.com");
  });
});

describe("processSubmission — failures", () => {
  it("still notifies every channel when sol-integrate can't be reached", async () => {
    solIntegrate = fakeService(() => new Response("error code: 1042", { status: 530 }));
    const { step } = fakeStep();

    const summary = await processSubmission(env(), params, step);

    expect(summary.integrations[0]).toEqual({ integrationId: NEWSLETTER_ID, outcome: "failed" });
    expect(solNotify.calls).toHaveLength(3);
    expect(notificationFor(GROUP_01_ID).fields.integrations).toEqual([
      { name: "Newsletter", typeLabel: "Mailchimp", outcome: "failed", detail: "Couldn't reach the integration service" },
    ]);
  });

  it("reports a rejected integration request as failed without throwing (no step retry)", async () => {
    solIntegrate = fakeService(() => fail(422, "Validation failed"));
    const { step, outputs } = fakeStep();

    await processSubmission(env(), params, step);

    expect(outputs[0]).toEqual({ outcome: "failed", detail: "Couldn't run this integration" });
    expect(notificationFor(GROUP_01_ID).fields.integrations[0]).toMatchObject({ outcome: "failed" });
  });

  it("passes a failed write's url and detail through to the notification", async () => {
    solIntegrate = fakeService(() =>
      ok({ outcome: "failed", url: "https://us21.admin.mailchimp.com/lists/", detail: "Member In Compliance State" })
    );
    const { step } = fakeStep();

    await processSubmission(env(), params, step);

    expect(notificationFor(GROUP_01_ID).fields.integrations).toEqual([
      { name: "Newsletter", typeLabel: "Mailchimp", outcome: "failed", url: "https://us21.admin.mailchimp.com/lists/", detail: "Member In Compliance State" },
    ]);
  });

  it("records a notification sol-notify rejects (e.g. Slack before SOL-13) and still sends the others", async () => {
    solNotify = fakeService((_path, body: any) =>
      body.type === "slack" ? fail(422, "Validation failed") : ok({ accepted: true }, 202)
    );
    const { step } = fakeStep();

    const summary = await processSubmission(env(), params, step);

    expect(summary.notifications).toEqual([
      { channelId: GROUP_01_ID, status: "sent" },
      { channelId: GROUP_02_ID, status: "sent" },
      { channelId: LEADS_SLACK_ID, status: "failed", detail: "sol-notify 422: Validation failed" },
    ]);
  });

  it("marks a notification failed when sol-notify stays unreachable", async () => {
    solNotify = fakeService(() => fail(503, "down"));
    const { step } = fakeStep();

    const summary = await processSubmission(env(), params, step);

    expect(summary.notifications.every((n) => n.status === "failed")).toBe(true);
    expect(summary.notifications[0].detail).toBe("Couldn't reach the notification service");
  });

  it("fails every notification when channels can't be resolved", async () => {
    solApi = fakeService(() => fail(500, "db down"));
    const { step } = fakeStep();

    const summary = await processSubmission(env(), params, step);

    expect(solNotify.calls).toHaveLength(0);
    expect(summary.notifications).toHaveLength(3);
    expect(summary.notifications.every((n) => n.status === "failed" && n.detail === "Couldn't resolve channels")).toBe(true);
  });

  it("skips a channel sol-api no longer has", async () => {
    solApi = fakeService(() => ok(form01Channels.filter((c) => c.id !== GROUP_02_ID)));
    const { step } = fakeStep();

    const summary = await processSubmission(env(), params, step);

    expect(summary.notifications[1]).toEqual({ channelId: GROUP_02_ID, status: "skipped", detail: "Channel not found" });
    expect(solNotify.calls).toHaveLength(2);
  });

  it("skips an integration whose mapping can't produce a write, without calling sol-integrate", async () => {
    const { step } = fakeStep();
    const { email: _email, ...noEmail } = submission;

    const summary = await processSubmission(env(), { ...params, fields: noEmail }, step);

    expect(solIntegrate.calls).toHaveLength(0);
    expect(summary.integrations[0]).toEqual({ integrationId: NEWSLETTER_ID, outcome: "skipped" });
  });

  it("does nothing more for a form with no channels", async () => {
    const { step, names } = fakeStep();

    await processSubmission(env(), { ...params, form: { ...form01, channels: [] } }, step);

    expect(names).toEqual([`integration ${NEWSLETTER_ID}`]);
    expect(solApi.calls).toHaveLength(0);
  });
});

describe("processSubmission — log level", () => {
  async function processedLine() {
    const logSpy = vi.spyOn(console, "log");
    const errorSpy = vi.spyOn(console, "error");
    await processSubmission(env(), params, fakeStep().step);
    const lines = [...logSpy.mock.calls, ...errorSpy.mock.calls].map(([line]) => JSON.parse(line));
    logSpy.mockRestore();
    errorSpy.mockRestore();
    return lines.find((e) => e.message === "submission processed");
  }

  it("logs the summary at info when everything went through", async () => {
    expect((await processedLine()).level).toBe("info");
  });

  it("logs the summary at warn when an integration failed", async () => {
    solIntegrate = fakeService(() => ok({ outcome: "failed", detail: "Member In Compliance State" }));
    expect((await processedLine()).level).toBe("warn");
  });

  it("logs the summary at warn when a notification failed", async () => {
    solNotify = fakeService(() => fail(422, "Validation failed"));
    expect((await processedLine()).level).toBe("warn");
  });
});

describe("processSubmission — trace and submission ids (SOL-46)", () => {
  it("sends the run's trace and submission ids to every service it calls, through steps and parallel work", async () => {
    await withLogScope({ environment: "staging", traceId: "trace-1", submissionId: SUBMISSION_ID }, () =>
      processSubmission(env(), params, fakeStep().step)
    );

    const allCalls = [...solIntegrate.calls, ...solApi.calls, ...solNotify.calls];
    expect(allCalls.length).toBeGreaterThan(0);
    expect(allCalls.every((c) => c.traceIdHeader === "trace-1" && c.submissionIdHeader === SUBMISSION_ID)).toBe(true);
  });
});

describe("stepInLogScope", () => {
  // Like Workflows: the step keeps its callback and runs it later, in a fresh
  // async context, rather than inline inside whatever scope called step.do().
  function detachedStep() {
    const callbacks: (() => Promise<unknown>)[] = [];
    const step: Step = {
      do: async <T>(_name: string, _config: unknown, callback: () => Promise<T>) => {
        callbacks.push(callback);
        return undefined as T;
      },
    };
    return { step, runLater: () => callbacks[0]() };
  }

  const scope = { environment: "staging", traceId: "trace-1", submissionId: "sub-1" };

  it("loses the run's scope inside a step that runs its callback later — the bug it fixes", async () => {
    const { step, runLater } = detachedStep();
    await withLogScope(scope, () => step.do("x", {}, async () => currentLogScope()));
    expect(await runLater()).toEqual({});
  });

  it("runs every step callback inside the run's scope", async () => {
    const { step, runLater } = detachedStep();
    await withLogScope(scope, () => stepInLogScope(step, scope).do("x", {}, async () => currentLogScope()));
    expect(await runLater()).toEqual(scope);
  });
});
