import { describe, it, expect, vi, afterEach } from "vitest";
import { verifyTurnstile, TurnstileUnavailableError } from "../../../src/lib/turnstile.js";

afterEach(() => vi.restoreAllMocks());

describe("verifyTurnstile", () => {
  it("posts the secret, token and IP to siteverify", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ success: true, "error-codes": [] }));

    await expect(verifyTurnstile("secret", "token", { remoteIp: "203.0.113.7" })).resolves.toEqual({ success: true, errorCodes: [] });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    const form = init!.body as FormData;
    expect(form.get("secret")).toBe("secret");
    expect(form.get("response")).toBe("token");
    expect(form.get("remoteip")).toBe("203.0.113.7");
  });

  it("reports a rejected token with its error codes", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ success: false, "error-codes": ["timeout-or-duplicate"] }));
    await expect(verifyTurnstile("secret", "token")).resolves.toEqual({ success: false, errorCodes: ["timeout-or-duplicate"] });
  });

  it.each([
    ["a network error", () => Promise.reject(new TypeError("fetch failed"))],
    ["a 5xx", () => Promise.resolve(new Response("oops", { status: 502 }))],
  ])("throws TurnstileUnavailableError on %s", async (_label, respond) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(respond as never);
    await expect(verifyTurnstile("secret", "token")).rejects.toBeInstanceOf(TurnstileUnavailableError);
  });
});
