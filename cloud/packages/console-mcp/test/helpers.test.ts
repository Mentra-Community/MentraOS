import { describe, expect, test } from "bun:test";
import { redactSecrets } from "../src/utils/redact.ts";
import { requireConfirm, textContent } from "../src/tools/helpers.ts";

describe("redactSecrets", () => {
  test("redacts known secret keys", () => {
    const out = redactSecrets({ apiKey: "secret", name: "app" });
    expect(out).toEqual({ apiKey: "[REDACTED]", name: "app" });
  });
});

describe("requireConfirm", () => {
  test("requires confirm true", () => {
    expect(() => requireConfirm(undefined, "delete")).toThrow(/confirm/);
    expect(() => requireConfirm(false, "delete")).toThrow(/confirm/);
    expect(() => requireConfirm(true, "delete")).not.toThrow();
  });
});

describe("textContent", () => {
  test("stringifies undefined without empty text", () => {
    const out = textContent(undefined);
    expect(out.content[0].text).toBe("undefined");
  });
});
