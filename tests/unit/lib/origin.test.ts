import { describe, it, expect } from "vitest";
import { isAllowedOrigin } from "../../../src/lib/origin.js";

describe("isAllowedOrigin", () => {
  const allowed = ["https://acme.com", "https://WWW.Acme.com/"];

  it.each([
    ["https://acme.com", true],
    ["https://www.acme.com", true],
    ["http://acme.com", false],
    ["https://acme.com.evil.example", false],
    ["https://sub.acme.com", false],
    ["null", false],
    ["", false],
    [undefined, false],
  ])("%s → %s", (origin, expected) => {
    expect(isAllowedOrigin(origin, allowed)).toBe(expected);
  });

  it("allows nothing for a form with no allowed origins", () => {
    expect(isAllowedOrigin("https://acme.com", [])).toBe(false);
  });
});
