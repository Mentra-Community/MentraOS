import { afterEach, describe, expect, test } from "bun:test";
import { loadCredentials } from "./credentials";

const saved = {
  token: process.env.MENTRA_CLI_TOKEN,
  coreUrl: process.env.MENTRA_CORE_URL,
};

afterEach(() => {
  restoreEnv("MENTRA_CLI_TOKEN", saved.token);
  restoreEnv("MENTRA_CORE_URL", saved.coreUrl);
});

describe("environment credentials", () => {
  test("use the production Core default when no explicit Core URL is configured", async () => {
    process.env.MENTRA_CLI_TOKEN = "test-token";
    delete process.env.MENTRA_CORE_URL;

    expect(await loadCredentials()).toMatchObject({
      token: "test-token",
      coreUrl: "https://core.mentraglass.com",
    });
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
