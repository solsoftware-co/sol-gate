import type { Channel, Form } from "../../../src/lib/sol-api.js";

// The "Form 01" scenario used to pressure-test the schema
// (sol-brain/sol-api/03-scenario-form-01.md): two integrations, three
// channels, each channel with its own notification.

export const CLIENT_ID = "acme";
export const FORM_ID = "0f0f0f0f-0000-4000-8000-000000000001";
export const NEWSLETTER_ID = "1a1a1a1a-0000-4000-8000-000000000001";
export const LEADS_SHEET_ID = "2b2b2b2b-0000-4000-8000-000000000002";
export const GROUP_01_ID = "3c3c3c3c-0000-4000-8000-000000000003";
export const GROUP_02_ID = "4d4d4d4d-0000-4000-8000-000000000004";
export const LEADS_SLACK_ID = "5e5e5e5e-0000-4000-8000-000000000005";

export const form01: Form = {
  id: FORM_ID,
  clientId: CLIENT_ID,
  name: "Form 01",
  description: null,
  payloadSchema: {
    type: "object",
    required: ["firstName", "lastName", "email"],
    properties: {
      firstName: { type: "string", minLength: 1 },
      lastName: { type: "string", minLength: 1 },
      email: { type: "string", format: "email" },
      interestedIn: { type: "string" },
      budget: { type: "string" },
      comment: { type: "string" },
    },
  },
  allowedOrigins: ["https://acme.com"],
  createdAt: "2026-09-26T00:00:00.000Z",
  updatedAt: "2026-09-26T00:00:00.000Z",
  integrations: [
    {
      integrationId: NEWSLETTER_ID,
      type: "mailchimp",
      name: "Newsletter",
      status: "active",
      fieldMapping: { email: "email", mergeFields: { FNAME: "firstName", LNAME: "lastName" } },
    },
    {
      integrationId: LEADS_SHEET_ID,
      type: "google_sheets",
      name: "Leads sheet",
      status: "active",
      fieldMapping: { columns: ["firstName", "lastName", "email", "interestedIn", "budget", "comment"] },
    },
  ],
  channels: [
    {
      channelId: GROUP_01_ID,
      type: "email",
      name: "Email group 01",
      template: "form_submission",
      subject: "New Mailchimp subscriber",
      includeFields: ["firstName", "lastName", "email"],
      message: null,
      integrationIds: [NEWSLETTER_ID],
    },
    {
      channelId: GROUP_02_ID,
      type: "email",
      name: "Email group 02",
      template: "form_submission",
      subject: "Form 01 submission",
      includeFields: null,
      message: null,
      // Deliberately not in the form's integration order.
      integrationIds: [LEADS_SHEET_ID, NEWSLETTER_ID],
    },
    {
      channelId: LEADS_SLACK_ID,
      type: "slack",
      name: "#leads",
      template: "form_submission",
      subject: null,
      includeFields: null,
      message: "form 01 just ran successfully!",
      integrationIds: [],
    },
  ],
};

const base = { clientId: CLIENT_ID, description: null, createdAt: "2026-09-26T00:00:00.000Z", updatedAt: "2026-09-26T00:00:00.000Z" };

// What GET /v1/clients/acme/channels?ids=… returns for Form 01 (ordered by name).
export const form01Channels: (Channel & Record<string, unknown>)[] = [
  { ...base, id: LEADS_SLACK_ID, type: "slack", name: "#leads", slack: { webhookUrl: "https://hooks.slack.com/services/T000/B000/SECRETWEBHOOK" } },
  { ...base, id: GROUP_01_ID, type: "email", name: "Email group 01", email: { emailAddresses: ["g1@acme.test"] } },
  { ...base, id: GROUP_02_ID, type: "email", name: "Email group 02", email: { emailAddresses: ["g2@acme.test"] } },
];

export const submission = {
  firstName: "Jane",
  lastName: "Doe",
  email: "jane@example.com",
  interestedIn: "Websites",
  budget: "$5-10k",
  comment: "Looking for a quote",
};
