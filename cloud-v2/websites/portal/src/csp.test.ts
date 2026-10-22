import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FLEET_MODULE_URL } from "./pages/fleet";

/**
 * The portal loads Fleet Management's UI as a script from its own origin (`FLEET_MODULE_URL`) and mounts it in
 * a shadow root that carries its own styles; the module calls the portal's own `/api`. The policy in
 * `public/_headers` has to allow exactly that and nothing wider.
 */
const policy = (() => {
  const text = readFileSync(join(import.meta.dir, "..", "public", "_headers"), "utf8");
  const line = text.split("\n").find(entry => entry.trim().startsWith("Content-Security-Policy:"));
  if (!line) throw new Error("public/_headers has no Content-Security-Policy");
  return new Map(
    line
      .slice(line.indexOf(":") + 1)
      .split(";")
      .map(part => part.trim().split(/\s+/))
      .filter(parts => parts[0])
      .map(([directive, ...sources]) => [directive!, sources] as const),
  );
})();

describe("the portal's Content-Security-Policy", () => {
  test("the Fleet module is a same-origin script, so script-src 'self' loads it and nothing else does", () => {
    expect(FLEET_MODULE_URL.startsWith("/")).toBe(true);
    expect(policy.get("script-src")).toEqual(["'self'"]);
  });

  test("the module's API calls are same-origin, and nothing may frame the portal or be framed by it", () => {
    expect(policy.get("connect-src")).toEqual(["'self'"]);
    expect(policy.get("frame-src")).toEqual(["'none'"]);
    expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
    expect(policy.get("object-src")).toEqual(["'none'"]);
  });

  test("the shadow root's inline styles are allowed, scripts are never inline or eval'd", () => {
    expect(policy.get("style-src")).toContain("'unsafe-inline'");
    expect(policy.get("script-src")).not.toContain("'unsafe-inline'");
    expect(policy.get("script-src")).not.toContain("'unsafe-eval'");
    expect(policy.get("default-src")).toEqual(["'self'"]);
  });
});
