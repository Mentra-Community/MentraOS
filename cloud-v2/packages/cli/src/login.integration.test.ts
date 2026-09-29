import {expect, test} from "bun:test";
import {spawnSync} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

test("login waits for browser approval, saves the Store session and confirms success", () => {
  const dir = mkdtempSync(join(tmpdir(), "mentra-cli-login-"));
  const stdoutPath = join(dir, "stdout.txt");
  try {
    for (const launcher of ["open", "xdg-open"]) {
      writeFileSync(join(dir, launcher), "#!/bin/sh\nsleep 3\n", {mode: 0o755});
    }
    const saved = join(dir, "session.json");
    const preload = join(dir, "preload.ts");
    // No real browser, network, credentials or publisher keys are used.
    writeFileSync(preload, `
      import {appendFileSync, writeFileSync} from "node:fs";
      console.log = (...args) => appendFileSync(${JSON.stringify(stdoutPath)}, args.join(" ") + "\\n");
      Object.defineProperty(Bun, "secrets", {value: {
        get: async () => null,
        set: async ({service, value}) => {
          if (service !== "mentra-store-cli") throw new Error("Unexpected credential write");
          writeFileSync(${JSON.stringify(saved)}, value);
        },
      }});
      let polls = 0;
      globalThis.fetch = async input => {
        const url = String(input);
        if (url === "https://store.example.test/api/console/auth/cli-config") return Response.json({workosClientId: "fixture-client"});
        if (url === "https://workos.example.test/user_management/authorize/device") return Response.json({
          device_code: "fixture-device", user_code: "FIXTURE-CODE",
          verification_uri_complete: "https://login.example.test/device", expires_in: 10, interval: 0.001,
        });
        if (url === "https://workos.example.test/user_management/authenticate") {
          if (++polls === 1) return Response.json({error: "authorization_pending"}, {status: 400});
          return Response.json({access_token: "fixture-token", refresh_token: "fixture-refresh", expires_in: 3600,
            user: {id: "fixture-user", email: "fixture@example.test"}});
        }
        if (url === "https://store.example.test/api/console/auth/me") return Response.json({
          organizationId: "dorg_fixture", organizations: [{id: "dorg_fixture"}],
        });
        throw new Error("Unexpected network request");
      };
    `);
    const result = spawnSync(process.execPath, ["--preload", preload, new URL("./index.ts", import.meta.url).pathname, "login"], {
      cwd: dir,
      env: {...process.env, NODE_ENV: "development", PATH: `${dir}:${process.env.PATH}`,
        MENTRA_STORE_URL: "https://store.example.test", MENTRA_WORKOS_CLIENT_ID: "",
        WORKOS_API_BASE_URL: "https://workos.example.test", MENTRA_CLI_TOKEN: ""},
      encoding: "utf8", timeout: 2000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(readFileSync(stdoutPath, "utf8")).toContain("Signed in as fixture@example.test");
    expect(readFileSync(stdoutPath, "utf8")).toContain("Credentials stored in OS keychain");
    expect(JSON.parse(readFileSync(saved, "utf8"))).toMatchObject({
      storeUrl: "https://store.example.test", developerOrgId: "dorg_fixture", token: "fixture-token",
    });
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
