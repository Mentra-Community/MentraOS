import { describe, expect, test } from "bun:test";
import { CORE_URLS, loadConfig, requireCapability } from "../src/config";

describe("loadConfig", () => {
  test("defaults to prod core URL with no capabilities", () => {
    const config = loadConfig({});
    expect(config.coreUrl).toBe(CORE_URLS.prod);
    expect(config.capabilities.reports).toBe(false);
  });

  test("MENTRA_ENV selects the deployment", () => {
    expect(loadConfig({ MENTRA_ENV: "staging" }).coreUrl).toBe(CORE_URLS.staging);
    expect(loadConfig({ MENTRA_ENV: "dev" }).coreUrl).toBe(CORE_URLS.dev);
    expect(loadConfig({ MENTRA_ENV: "Prod" }).coreUrl).toBe(CORE_URLS.prod);
  });

  test("unknown MENTRA_ENV throws", () => {
    expect(() => loadConfig({ MENTRA_ENV: "qa" })).toThrow(/Unknown MENTRA_ENV/);
  });

  test("MENTRA_CORE_URL overrides MENTRA_ENV and strips trailing slashes", () => {
    const config = loadConfig({
      MENTRA_ENV: "dev",
      MENTRA_CORE_URL: "http://localhost:3000//",
    });
    expect(config.coreUrl).toBe("http://localhost:3000");
  });

  test("MENTRA_ADMIN_TOKEN enables the reports capability", () => {
    const config = loadConfig({ MENTRA_ADMIN_TOKEN: "msk_prod_abc.def" });
    expect(config.capabilities.reports).toBe(true);
    expect(config.adminToken).toBe("msk_prod_abc.def");
  });

  test("blank MENTRA_ADMIN_TOKEN stays disabled", () => {
    expect(loadConfig({ MENTRA_ADMIN_TOKEN: "   " }).capabilities.reports).toBe(false);
  });
});

describe("requireCapability", () => {
  test("throws with the env hint when unconfigured", () => {
    expect(() => requireCapability(loadConfig({}), "reports")).toThrow(/MENTRA_ADMIN_TOKEN/);
  });

  test("passes when configured", () => {
    expect(() =>
      requireCapability(loadConfig({ MENTRA_ADMIN_TOKEN: "tok" }), "reports"),
    ).not.toThrow();
  });
});
