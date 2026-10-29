import { expect, test } from "bun:test";
import { developerConsoleUrl } from "../websites/portal/src/lib/config";
import { workspacePortalUrl } from "../websites/admin/src/lib/config";
import { adminBuildConfig, developerConsoleUrls, portalBuildConfig, portalUrls } from "./deploy-pages";

test("each environment's workspace portal links to its own Developer Console", () => {
  expect(developerConsoleUrls).toEqual({
    dev: "https://console.dev.mentraglass.com",
    staging: "https://console.staging.mentraglass.com",
    prod: "https://console.mentraglass.com",
  });
});

test("portal builds link to services in their own environment", () => {
  expect(portalUrls).toEqual({
    dev: "https://portal.dev.mentraglass.com",
    staging: "https://portal.staging.mentraglass.com",
    prod: "https://portal.mentraglass.com",
  });
  for (const env of ["dev", "staging", "prod"] as const) {
    const config = portalBuildConfig(env);
    expect(config).toEqual({ DEVELOPER_CONSOLE_URL: developerConsoleUrls[env] });
    expect(developerConsoleUrl(config.DEVELOPER_CONSOLE_URL)).toBe(developerConsoleUrls[env]);
    const adminConfig = adminBuildConfig(env);
    expect(adminConfig).toEqual({ PORTAL_URL: portalUrls[env] });
    expect(workspacePortalUrl(adminConfig.PORTAL_URL)).toBe(portalUrls[env]);
  }
});
