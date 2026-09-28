import { describe, it, expect } from "vitest";
import { validateFields, displayValue } from "../../../src/lib/payload-schema.js";
import { form01, submission } from "../fixtures/form-01.js";

describe("validateFields", () => {
  it("accepts a submission that matches the schema", () => {
    expect(validateFields(form01.payloadSchema, submission)).toEqual([]);
  });

  it("lists each problem with a JSON Pointer path, not the summary errors", () => {
    const errors = validateFields(form01.payloadSchema, { firstName: "", email: "nope", budget: 5 });
    expect(errors).toEqual(
      expect.arrayContaining([
        { path: "", message: 'Instance does not have required property "lastName".' },
        { path: "/email", message: 'String does not match format "email".' },
        { path: "/budget", message: 'Instance type "number" is invalid. Expected "string".' },
      ])
    );
    expect(errors.some((e) => e.message.includes("does not match schema"))).toBe(false);
  });

  it("accepts anything under an empty schema (sol-api's default)", () => {
    expect(validateFields({}, { anything: ["goes"] })).toEqual([]);
  });

  it("names an unexpected property under additionalProperties: false, alongside other errors", () => {
    const schema = { type: "object", required: ["email"], properties: { email: { type: "string" } }, additionalProperties: false };
    expect(validateFields(schema, { extra: "x" })).toEqual([
      { path: "", message: 'Instance does not have required property "email".' },
      { path: "", message: 'Property "extra" does not match additional properties schema.' },
    ]);
  });

  it("throws for a schema it can't use (the route turns that into a 500)", () => {
    expect(() => validateFields({ $ref: "#/nowhere" }, {})).toThrow();
  });
});

describe("displayValue", () => {
  it.each([
    ["Jane", "Jane"],
    [42, "42"],
    [true, "true"],
    [["a", "b"], "a, b"],
    [{ a: 1 }, '{"a":1}'],
    [null, null],
    [undefined, null],
  ])("%j → %j", (input, expected) => {
    expect(displayValue(input)).toBe(expected);
  });
});
