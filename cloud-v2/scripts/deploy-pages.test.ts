import { expect, test } from "bun:test";
import { developerConsoleUrl } from "../websites/portal/src/lib/config";
import { developerConsoleUrls, portalBuildConfig } from "./deploy-pages";

test("each environment's workspace portal links to its own Developer Console", () => {
  expect(developerConsoleUrls).toEqual({
    dev: "https://console.dev.mentraglass.com",
    staging: "https://console.staging.mentraglass.com",
    prod: "https://console.mentraglass.com",
  });
});

test("the portal's build gets its environment's Developer Console, in a form the portal accepts", () => {
  for (const env of ["dev", "staging", "prod"] as const) {
    const config = portalBuildConfig(env);
    expect(config).toEqual({ DEVELOPER_CONSOLE_URL: developerConsoleUrls[env] });
    expect(developerConsoleUrl(config.DEVELOPER_CONSOLE_URL)).toBe(developerConsoleUrls[env]);
  }
});
