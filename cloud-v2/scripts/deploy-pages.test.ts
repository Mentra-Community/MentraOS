import { expect, test } from "bun:test";
import { workspacePortalUrl } from "../websites/admin/src/lib/config";
import { adminBuildConfig, portalUrls } from "./deploy-pages";

test("each environment's admin portal links to its own workspace portal, in a form the admin portal accepts", () => {
  expect(portalUrls).toEqual({
    dev: "https://portal.dev.mentraglass.com",
    staging: "https://portal.staging.mentraglass.com",
    prod: "https://portal.mentraglass.com",
  });
  for (const env of ["dev", "staging", "prod"] as const) {
    const config = adminBuildConfig(env);
    expect(config).toEqual({ PORTAL_URL: portalUrls[env] });
    expect(workspacePortalUrl(config.PORTAL_URL)).toBe(portalUrls[env]);
  }
});
