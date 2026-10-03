import { describe, it, expect } from "vitest";
import { serviceFetch, ServiceError } from "../../../src/lib/service-fetch.js";
import { withLogScope } from "../../../src/lib/log-context.js";

const binding = (respond: () => Response | Promise<Response>) => ({ fetch: async () => respond() }) as unknown as Fetcher;
const call = (respond: () => Response | Promise<Response>, timeoutMs = 1_000) =>
  serviceFetch({ service: "sol-api", binding: binding(respond), apiKey: "k", path: "/x", timeoutMs });

describe("serviceFetch", () => {
  it("returns data from a success envelope", async () => {
    await expect(call(() => Response.json({ success: true, data: { a: 1 } }))).resolves.toEqual({ status: 200, data: { a: 1 } });
  });

  it("surfaces a non-JSON body (e.g. error 1042) with its status", async () => {
    const err = await call(() => new Response("error code: 1042", { status: 530 })).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect(err.status).toBe(530);
    expect(err.message).toContain("error code: 1042");
    expect(err.permanent).toBe(false);
  });

  it.each([
    [404, true],
    [422, true],
    [429, false],
    [500, false],
  ])("a %i error envelope is permanent: %s", async (status, permanent) => {
    const err = await call(() => Response.json({ success: false, error: { code: "X", message: "nope" } }, { status })).catch((e) => e);
    expect(err.status).toBe(status);
    expect(err.permanent).toBe(permanent);
  });

  it("turns a timeout into a retryable ServiceError with no status", async () => {
    const err = await serviceFetch({
      service: "sol-notify",
      binding: {
        fetch: (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) =>
            init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
          ),
      } as unknown as Fetcher,
      apiKey: "k",
      path: "/",
      timeoutMs: 10,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect(err.status).toBeNull();
    expect(err.permanent).toBe(false);
    expect(err.message).toContain("timed out");
  });

  it("forwards the scope's trace and submission ids, and sends neither outside a scope", async () => {
    const sent: Headers[] = [];
    const recording = {
      fetch: async (_url: string, init: RequestInit) => {
        sent.push(new Headers(init.headers));
        return Response.json({ success: true, data: {} });
      },
    } as unknown as Fetcher;
    const opts = { service: "sol-api" as const, binding: recording, apiKey: "k", path: "/x", timeoutMs: 1_000 };

    await withLogScope({ traceId: "trace-1", submissionId: "sub-1" }, () => serviceFetch(opts));
    await serviceFetch(opts);

    expect(sent[0].get("X-Trace-Id")).toBe("trace-1");
    expect(sent[0].get("X-Submission-Id")).toBe("sub-1");
    expect(sent[1].has("X-Trace-Id")).toBe(false);
    expect(sent[1].has("X-Submission-Id")).toBe(false);
  });
});
