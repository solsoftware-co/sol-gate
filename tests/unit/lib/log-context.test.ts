import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withLogScope, currentLogScope } from "../../../src/lib/log-context.js";
import { logger } from "../../../src/lib/logger.js";

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logSpy = vi.spyOn(console, "log");
});
afterEach(() => vi.restoreAllMocks());

const loggedLines = () => logSpy.mock.calls.map(([line]) => JSON.parse(line as string));

describe("log scope", () => {
  it("adds environment, traceId and submissionId to every log line inside the scope", async () => {
    await withLogScope({ environment: "staging", traceId: "trace-1", submissionId: "sub-1" }, async () => {
      logger.info("before an await");
      await Promise.resolve();
      logger.info("after an await", { formId: "f-1" });
    });

    const lines = loggedLines();
    expect(lines[0]).toMatchObject({ message: "before an await", environment: "staging", submissionId: "sub-1" });
    expect(lines[1]).toMatchObject({ message: "after an await", environment: "staging", traceId: "trace-1", submissionId: "sub-1", formId: "f-1" });
  });

  it("adds a nested scope's fields to the outer one's", async () => {
    await withLogScope({ environment: "staging" }, () =>
      withLogScope({ submissionId: "sub-1" }, async () => logger.info("nested"))
    );
    expect(loggedLines()[0]).toMatchObject({ environment: "staging", submissionId: "sub-1" });
  });

  it("adds nothing outside a scope", () => {
    logger.info("no scope");
    const lines = loggedLines();
    expect(lines[0]).not.toHaveProperty("submissionId");
    expect(lines[0]).not.toHaveProperty("environment");
    expect(currentLogScope()).toEqual({});
  });

  it("keeps concurrent scopes apart", async () => {
    const seen = await Promise.all(
      ["a", "b"].map((id) =>
        withLogScope({ submissionId: id }, async () => {
          await new Promise((r) => setTimeout(r, id === "a" ? 5 : 0));
          return currentLogScope().submissionId;
        })
      )
    );
    expect(seen).toEqual(["a", "b"]);
  });
});
