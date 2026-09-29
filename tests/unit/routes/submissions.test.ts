import { describe, it, expect, vi, beforeEach } from "vitest";
import app from "../../../src/index.js";
import { CLIENT_ID, FORM_ID, form01, submission } from "../fixtures/form-01.js";

const PATH = `/v1/clients/${CLIENT_ID}/forms/${FORM_ID}/submissions`;
const FORM_PATH = `/v1/clients/${CLIENT_ID}/forms/${FORM_ID}`;
const VERIFY_PATH = `${FORM_PATH}/api-keys/verify`;
const FORM_KEY = "sgk_valid-form-key";
const KEY_ID = "9a9a9a9a-0000-4000-8000-000000000009";

// Fake sol-api: answers the key check (POST …/api-keys/verify) and the
// form lookup (GET …/forms/:formId) separately.
let verifyResponse: (key: string) => Response;
let solApiResponse: () => Response;
let solApiCalls: { method: string; path: string; body?: any }[];
let formAllowed: boolean;
let rateLimitKeys: string[];
let workflowCreate: ReturnType<typeof vi.fn>;

function env(overrides: Record<string, unknown> = {}) {
  return {
    ENVIRONMENT: "staging",
    SOL_API: {
      fetch: async (input: string, init?: RequestInit) => {
        const path = new URL(input).pathname;
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        solApiCalls.push({ method: init?.method ?? "GET", path, ...(body && { body }) });
        return path === VERIFY_PATH ? verifyResponse(body.key) : solApiResponse();
      },
    } as unknown as Fetcher,
    SOL_API_KEY: "api-key",
    SOL_INTEGRATE: {} as Fetcher,
    SOL_INTEGRATE_API_KEY: "integrate-key",
    SOL_NOTIFY: {} as Fetcher,
    SOL_NOTIFY_API_KEY: "notify-key",
    FORM_RATE_LIMITER: { limit: async ({ key }: { key: string }) => (rateLimitKeys.push(`form:${key}`), { success: formAllowed }) },
    SUBMISSION_WORKFLOW: { create: workflowCreate },
    ...overrides,
  };
}

async function send(
  opts: { method?: string; body?: unknown; rawBody?: string; headers?: Record<string, string>; path?: string; env?: Record<string, unknown> } = {}
) {
  const res = await app.request(
    opts.path ?? PATH,
    {
      method: opts.method ?? "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": FORM_KEY, ...opts.headers },
      body: opts.rawBody ?? JSON.stringify(opts.body ?? { fields: submission }),
    },
    env(opts.env)
  );
  return { res, json: res.headers.get("Content-Type")?.includes("json") ? ((await res.json()) as any) : null };
}

const solApiPaths = () => solApiCalls.map((call) => call.path);

beforeEach(() => {
  verifyResponse = (key) =>
    Response.json({ success: true, data: key === FORM_KEY ? { authenticated: true, keyId: KEY_ID } : { authenticated: false } });
  solApiResponse = () => Response.json({ success: true, data: form01 });
  solApiCalls = [];
  formAllowed = true;
  rateLimitKeys = [];
  workflowCreate = vi.fn().mockResolvedValue({ id: "instance" });
});

describe("POST /v1/clients/:clientId/forms/:formId/submissions", () => {
  it("accepts a valid submission: 202 with a submissionId, and starts one workflow instance for it", async () => {
    const { res, json } = await send();

    expect(res.status).toBe(202);
    expect(json.success).toBe(true);
    const { submissionId } = json.data;
    expect(submissionId).toMatch(/^[0-9a-f-]{36}$/);

    expect(workflowCreate).toHaveBeenCalledTimes(1);
    const { id, params } = workflowCreate.mock.calls[0][0];
    expect(id).toBe(submissionId);
    expect(params).toMatchObject({
      submissionId,
      clientId: CLIENT_ID,
      fields: submission,
      form: { id: FORM_ID, name: "Form 01", integrations: form01.integrations, channels: form01.channels },
    });
  });

  it("verifies the form key with sol-api (key in the body, never the URL), then loads the form", async () => {
    await send();
    expect(solApiCalls).toEqual([
      { method: "POST", path: VERIFY_PATH, body: { key: FORM_KEY } },
      { method: "GET", path: FORM_PATH },
    ]);
  });

  it("logs which form key was used (its id, unredacted) and never the key itself", async () => {
    const logSpy = vi.spyOn(console, "log");
    await send();

    const accepted = logSpy.mock.calls.map(([line]) => JSON.parse(line)).find((e) => e.message === "submission accepted");
    expect(accepted.credentialId).toBe(KEY_ID);
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(FORM_KEY);
    logSpy.mockRestore();
  });

  it.each([
    ["no key", ""],
    ["a key without the sgk_ prefix", "gate-key"],
  ])("401s %s without calling sol-api", async (_label, key) => {
    const { res, json } = await send({ headers: { "X-API-Key": key } });

    expect(res.status).toBe(401);
    expect(json.error.code).toBe("UNAUTHORIZED");
    expect(solApiCalls).toHaveLength(0);
    expect(rateLimitKeys).toHaveLength(0);
  });

  it("401s a key sol-api doesn't accept for this form, before rate limiting or loading the form", async () => {
    const { res, json } = await send({ headers: { "X-API-Key": "sgk_someone-elses-key" } });

    expect(res.status).toBe(401);
    expect(json.error.code).toBe("UNAUTHORIZED");
    expect(solApiPaths()).toEqual([VERIFY_PATH]);
    expect(rateLimitKeys).toHaveLength(0);
    expect(workflowCreate).not.toHaveBeenCalled();
  });

  it("503s (not 401s) when sol-api can't verify the key", async () => {
    verifyResponse = () => new Response("error code: 1042", { status: 530 });
    const { res, json } = await send();

    expect(res.status).toBe(503);
    expect(json.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(workflowCreate).not.toHaveBeenCalled();
  });

  it("ignores the Origin header (callers are servers; there's no Origin check)", async () => {
    const { res } = await send({ headers: { Origin: "https://anything.example" } });
    expect(res.status).toBe(202);
  });

  it("rate limits per form", async () => {
    await send();
    expect(rateLimitKeys).toEqual([`form:${CLIENT_ID}:${FORM_ID}`]);
  });

  it("429s when the form's rate limit is hit, before loading the form", async () => {
    formAllowed = false;
    const { res, json } = await send();

    expect(res.status).toBe(429);
    expect(json.error.code).toBe("RATE_LIMITED");
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(solApiPaths()).toEqual([VERIFY_PATH]);
  });

  it("404s an unknown form, or a form under another client", async () => {
    solApiResponse = () => Response.json({ success: false, error: { code: "NOT_FOUND", message: "Form not found" } }, { status: 404 });
    const { res, json } = await send();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe("NOT_FOUND");
    expect(workflowCreate).not.toHaveBeenCalled();
  });

  it("503s when sol-api can't load the form", async () => {
    solApiResponse = () => new Response("error code: 1042", { status: 530 });
    const { res, json } = await send();

    expect(res.status).toBe(503);
    expect(json.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(JSON.stringify(json)).not.toContain("1042");
  });

  it("422s fields that don't match the form's payload_schema, with details", async () => {
    const { res, json } = await send({
      body: { fields: { firstName: "Jane", email: "not-an-email" } },
    });

    expect(res.status).toBe(422);
    expect(json.error.details).toEqual(
      expect.arrayContaining([
        { path: "", message: 'Instance does not have required property "lastName".' },
        { path: "/email", message: 'String does not match format "email".' },
      ])
    );
    expect(workflowCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["non-JSON", "not json"],
    ["missing fields", JSON.stringify({})],
    ["fields that aren't an object", JSON.stringify({ fields: ["a"] })],
  ])("422s %s", async (_label, rawBody) => {
    const { res } = await send({ rawBody });

    expect(res.status).toBe(422);
    expect(workflowCreate).not.toHaveBeenCalled();
  });

  it("413s an oversized body", async () => {
    const { res, json } = await send({
      body: { fields: { comment: "x".repeat(70 * 1024) } },
    });

    expect(res.status).toBe(413);
    expect(json.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("ignores any recipients, templates or integrations the caller tries to supply", async () => {
    await send({
      body: {
        fields: submission,
        recipients: ["attacker@evil.example"],
        channels: [],
        integrations: [],
      },
    });

    const { params } = workflowCreate.mock.calls[0][0];
    expect(JSON.stringify(params)).not.toContain("attacker@evil.example");
    expect(params.form.channels).toEqual(form01.channels);
  });

  it("500s with the error envelope when the workflow can't be started", async () => {
    workflowCreate.mockRejectedValue(new Error("workflow binding broken"));
    const { res, json } = await send();

    expect(res.status).toBe(500);
    expect(json.error.code).toBe("INTERNAL_ERROR");
  });

  it("500s every request on an invalid ENVIRONMENT", async () => {
    const { res } = await send({ env: { ENVIRONMENT: "prod" } });
    expect(res.status).toBe(500);
    expect(workflowCreate).not.toHaveBeenCalled();
  });
});

describe("other routes", () => {
  it("GET /health needs no key", async () => {
    const res = await app.request("/health", {}, env());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, data: { status: "ok", environment: "staging" } });
  });

  it("404s unknown routes with the error envelope", async () => {
    const res = await app.request("/nope", {}, env());
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
  });
});
