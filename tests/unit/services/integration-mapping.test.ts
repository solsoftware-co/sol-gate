import { describe, it, expect } from "vitest";
import { mapIntegrationFields, integrationDisplayName, integrationTypeLabel } from "../../../src/services/integration-mapping.js";
import type { FormIntegration } from "../../../src/lib/sol-api.js";
import { form01, submission } from "../fixtures/form-01.js";

const mailchimp = (fieldMapping: Record<string, unknown>): FormIntegration => ({
  integrationId: "i-1",
  type: "mailchimp",
  name: "Newsletter",
  status: "active",
  fieldMapping,
});

describe("mapIntegrationFields — mailchimp", () => {
  it("maps Form 01's Newsletter mapping", () => {
    expect(mapIntegrationFields(form01.integrations[0], submission)).toEqual({
      ok: true,
      fields: { email: "jane@example.com", mergeFields: { FNAME: "Jane", LNAME: "Doe" } },
    });
  });

  it("drops merge fields whose form field is empty or missing", () => {
    const result = mapIntegrationFields(mailchimp({ email: "email", mergeFields: { FNAME: "firstName", PHONE: "phone" } }), {
      email: "jane@example.com",
      firstName: "  ",
    });
    expect(result).toEqual({ ok: true, fields: { email: "jane@example.com" } });
  });

  it("passes fixed tags and statusIfNew through from the mapping", () => {
    const result = mapIntegrationFields(mailchimp({ email: "email", tags: ["website"], statusIfNew: "pending" }), submission);
    expect(result).toEqual({ ok: true, fields: { email: "jane@example.com", tags: ["website"], statusIfNew: "pending" } });
  });

  it("skips when no email was submitted", () => {
    expect(mapIntegrationFields(mailchimp({ email: "email" }), { firstName: "Jane" })).toEqual({
      ok: false,
      result: { outcome: "skipped", detail: "No email address was submitted" },
    });
  });

  it("skips an invalid mapping", () => {
    expect(mapIntegrationFields(mailchimp({ mergeFields: {} }), submission)).toEqual({
      ok: false,
      result: { outcome: "skipped", detail: "The form's Mailchimp field mapping is invalid" },
    });
  });
});

const sheet = (fieldMapping: Record<string, unknown>): FormIntegration => ({
  integrationId: "i-2",
  type: "google_sheets",
  name: "Leads sheet",
  status: "active",
  fieldMapping,
});

describe("mapIntegrationFields — google_sheets", () => {
  it("maps Form 01's Leads sheet mapping, keyed by column", () => {
    expect(mapIntegrationFields(form01.integrations[1], submission)).toEqual({
      ok: true,
      fields: {
        values: {
          firstName: "Jane",
          lastName: "Doe",
          email: "jane@example.com",
          interestedIn: "Websites",
          budget: "$5-10k",
          comment: "Looking for a quote",
        },
      },
    });
  });

  it("maps column keys that differ from the form's field names", () => {
    const result = mapIntegrationFields(sheet({ columns: { submitterName: "firstName", submitterEmail: "email" } }), {
      firstName: "Jane",
      email: "jane@example.com",
    });
    expect(result).toEqual({ ok: true, fields: { values: { submitterName: "Jane", submitterEmail: "jane@example.com" } } });
  });

  it("leaves out empty or missing fields, and joins lists for display", () => {
    const result = mapIntegrationFields(sheet({ columns: ["firstName", "phone", "interests"] }), {
      firstName: "  ",
      interests: ["design", "seo"],
    });
    expect(result).toEqual({ ok: true, fields: { values: { interests: "design, seo" } } });
  });

  it.each([[{}], [{ columns: [] }], [{ columns: {} }], [{ columns: "email" }]])("skips an invalid mapping %j", (fieldMapping) => {
    expect(mapIntegrationFields(sheet(fieldMapping), submission)).toEqual({
      ok: false,
      result: { outcome: "skipped", detail: "The form's Google Sheets field mapping is invalid" },
    });
  });
});

describe("mapIntegrationFields — other types", () => {

  it("skips an unknown type", () => {
    const result = mapIntegrationFields({ ...mailchimp({}), type: "hubspot" }, submission);
    expect(result).toEqual({ ok: false, result: { outcome: "skipped", detail: "Unsupported integration type: hubspot" } });
  });
});

describe("integrationDisplayName", () => {
  it("uses the integration's name, else a label for its type", () => {
    expect(integrationDisplayName({ name: "Newsletter", type: "mailchimp" })).toBe("Newsletter");
    expect(integrationDisplayName({ name: null, type: "google_sheets" })).toBe("Google Sheets");
    expect(integrationDisplayName({ name: null, type: "hubspot" })).toBe("hubspot");
  });
});

describe("integrationTypeLabel", () => {
  it("names the service an integration writes to, whatever the integration is called", () => {
    expect(integrationTypeLabel("mailchimp")).toBe("Mailchimp");
    expect(integrationTypeLabel("google_sheets")).toBe("Google Sheets");
    expect(integrationTypeLabel("hubspot")).toBe("hubspot");
  });
});
