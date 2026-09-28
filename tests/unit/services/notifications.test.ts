import { describe, it, expect } from "vitest";
import { buildNotification, includedFields, replyCta, type NotificationInput } from "../../../src/services/notifications.js";
import { GROUP_01_ID, LEADS_SLACK_ID, form01, submission } from "../fixtures/form-01.js";

describe("includedFields", () => {
  it("NULL means every submitted field, in submitted order", () => {
    expect(Object.keys(includedFields(submission, null))).toEqual(Object.keys(submission));
  });

  it("[] means none", () => {
    expect(includedFields(submission, [])).toEqual({});
  });

  it("a list picks those fields, in list order, when submitted", () => {
    expect(includedFields(submission, ["email", "firstName", "phone"])).toEqual({ email: "jane@example.com", firstName: "Jane" });
  });

  it("stringifies non-string values and drops nulls", () => {
    expect(includedFields({ n: 3, tags: ["a", "b"], gone: null }, null)).toEqual({ n: "3", tags: "a, b" });
  });
});

describe("replyCta", () => {
  it("uses the schema's format: email field and the submitter's first name", () => {
    expect(replyCta(submission, form01.payloadSchema)).toEqual({ url: "mailto:jane@example.com", label: "Reply to Jane" });
  });

  it("prefers a full name field", () => {
    expect(replyCta({ name: "Jane Doe", email: "jane@example.com" }, {})).toEqual({
      url: "mailto:jane@example.com",
      label: "Reply to Jane Doe",
    });
  });

  it("falls back to a field named like email, and a plain label without a name", () => {
    expect(replyCta({ Email: "jane@example.com" }, {})).toEqual({ url: "mailto:jane@example.com", label: "Reply" });
  });

  it.each([
    ["no email field", { name: "Jane" }],
    ["an implausible address", { email: "jane@example.com?bcc=everyone@example.com" }],
    ["an empty address", { email: " " }],
  ])("is omitted for %s", (_label, fields) => {
    expect(replyCta(fields, {})).toBeUndefined();
  });
});

describe("buildNotification", () => {
  const context = { formId: form01.id, submissionId: "sub-1" };
  const input = (overrides: Partial<NotificationInput>): NotificationInput => ({
    clientId: "acme",
    formName: form01.name,
    payloadSchema: form01.payloadSchema,
    context,
    fields: submission,
    integrations: form01.integrations,
    results: {},
    channel: form01.channels[0],
    resolved: { id: GROUP_01_ID, type: "email", emailAddresses: ["g1@acme.test"] },
    ...overrides,
  });

  it("falls back to a subject from the form name", () => {
    const built = buildNotification(input({ channel: { ...form01.channels[0], subject: null } }));
    expect(built.ok && built.request.type === "email" && built.request.subject).toBe("New submission: Form 01");
  });

  it("omits integrations when the channel reports on none (opt-in)", () => {
    const built = buildNotification(input({ channel: { ...form01.channels[0], integrationIds: [] } }));
    expect(built.ok && built.request.type === "email" && "integrations" in built.request.fields).toBe(false);
  });

  it("skips an email group with no addresses", () => {
    const built = buildNotification(input({ resolved: { id: GROUP_01_ID, type: "email", emailAddresses: [] } }));
    expect(built).toEqual({ ok: false, reason: "Email group has no addresses" });
  });

  it("skips a Slack channel with no message", () => {
    const built = buildNotification(
      input({
        channel: { ...form01.channels[2], message: null },
        resolved: { id: LEADS_SLACK_ID, type: "slack", emailAddresses: [] },
      })
    );
    expect(built).toEqual({ ok: false, reason: "No message configured for this Slack channel" });
  });

  it("skips a channel whose type no longer matches", () => {
    const built = buildNotification(input({ resolved: { id: GROUP_01_ID, type: "slack", emailAddresses: [] } }));
    expect(built).toEqual({ ok: false, reason: "Channel not found" });
  });
});
