import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePackageSigningKey, verifySignedBundleArchive } from "@mentra/miniapp-cli";
import JSZip from "jszip";
import { DEFAULT_STORE_URL } from "./config";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "mentra-cli-regression-"));
  dirs.push(cwd);
  mkdirSync(join(cwd, "dist"));
  writeFileSync(
    join(cwd, "miniapp.json"),
    JSON.stringify({
      packageName: "com.example.fixture",
      version: "1.0.0",
      name: "Fixture",
      permissions: [],
      hardwareRequirements: [],
      entry: { background: "background.js" },
    }),
  );
  writeFileSync(join(cwd, "dist/background.js"), "console.log('fixture')");
  const preload = join(cwd, "preload.ts");
  // No real network or keychain accesses are permitted in this child process.
  writeFileSync(
    preload,
    `
    import {appendFileSync, writeFileSync} from "node:fs";
    Object.defineProperty(Bun, "secrets", {value: {get: async ({service}) => service === "mentra-miniapp-publisher-signing" ? process.env.MENTRA_TEST_PACKAGE_KEY || null : JSON.stringify({
      token: "old", refreshToken: "refresh", workosUserId: "user", email: "fixture@example.test",
      storeUrl: process.env.MENTRA_TEST_SAVED_STORE || "https://catalog.example.test",
      storedAt: "2020-01-01T00:00:00Z", expiresAt: "2020-01-01T00:00:01Z",
    }),
    set: async ({value}) => { writeFileSync(${JSON.stringify(join(cwd, "saved.json"))}, value); }}});
    globalThis.fetch = async (input) => {
      const url = String(input);
      appendFileSync(${JSON.stringify(join(cwd, "requests.txt"))}, url + "\\n");
      if (url.endsWith("/cli-config")) return Response.json({workosClientId: "client"});
      if (url.endsWith("/authenticate")) return Response.json({access_token: "new", expires_in: 3600, user: {id: "user", email: "fixture@example.test"}});
      if (url.endsWith("/api/console/apps")) return Response.json({app: {}});
      if (url.endsWith("/releases")) return Response.json({release: {id: "release", version: "1.0.0", status: "draft", releaseTrack: "stable"}});
      throw new Error("Unexpected network request: " + url);
    };
  `,
  );
  return { cwd, preload };
}

async function cli(
  f: ReturnType<typeof fixture>,
  args: string[],
  env: Record<string, string> = {},
  scriptName?: string,
) {
  const cloudDir = new URL("../../../", import.meta.url).pathname;
  const bin = join(f.cwd, "bin");
  let script: string | undefined;
  if (scriptName) {
    script = JSON.parse(readFileSync(join(cloudDir, "package.json"), "utf8")).scripts[scriptName];
    expect(typeof script).toBe("string");
    mkdirSync(bin);
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    // Run the actual package shortcut with the same isolated CLI fixture. A
    // regression must not load real Doppler credentials or access the network.
    writeFileSync(join(bin, "bun"), `#!/bin/sh\nexec ${quote(process.execPath)} --preload ${quote(f.preload)} "$@"\n`, { mode: 0o755 });
    writeFileSync(join(bin, "doppler"), "#!/bin/sh\necho 'Unexpected Doppler access' >&2\nexit 86\n", { mode: 0o755 });
  }
  const child = spawnSync(
    script ? "/bin/sh" : process.execPath,
    script
      ? ["-c", `${script} "$@"`, "mentra-script", ...args]
      : ["--preload", f.preload, new URL("./index.ts", import.meta.url).pathname, ...args],
    {
      cwd: script ? cloudDir : f.cwd,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        MENTRA_CORE_URL: "https://identity.example.test",
        MENTRA_STORE_URL: "https://catalog.example.test",
        MENTRA_CLI_HOME: join(f.cwd, "keys"),
        MENTRA_CLI_TOKEN: "",
        MENTRA_WORKOS_CLIENT_ID: "",
        WORKOS_CLIENT_ID: "",
        MENTRA_MINIAPP_SIGNING_KEY_FILE: "",
        MENTRA_MINIAPP_SIGNING_KEY_JSON: "",
        ...env,
      },
      encoding: "utf8",
    },
  );
  const { status: code, stdout, stderr } = child;
  if (code !== 0) throw new Error(`CLI exited ${code}: ${stdout} ${stderr}`);
  expect(code).toBe(0);
  return stdout;
}

describe("CLI publication and credential refresh", () => {
  test.each(["mentra", "mentra:dev", "mentra:staging", "mentra:prod", "mentra:local"])(
    "%s selects the Store independently of Core credentials",
    async (scriptName) => {
      const f = fixture();
      const storeUrl = scriptName === "mentra:local" ? "http://localhost:3003" : DEFAULT_STORE_URL;
      await cli(f, ["whoami"], {
        MENTRA_STORE_URL: "",
        MENTRA_TEST_SAVED_STORE: storeUrl,
        WORKOS_CLIENT_ID: "unrelated-core-client",
      }, scriptName);
      expect(readFileSync(join(f.cwd, "requests.txt"), "utf8").split("\n")[0]).toBe(
        `${storeUrl}/api/console/auth/cli-config`,
      );
      expect(JSON.parse(readFileSync(join(f.cwd, "saved.json"), "utf8"))).toMatchObject({ storeUrl });
    },
  );

  test.each(["https://catalog.example.test", "https://override.example.test"])(
    "refresh stays scoped to the selected Store %s",
    async (override) => {
      const f = fixture();
      await cli(f, ["--store-url", override, "whoami"], { MENTRA_TEST_SAVED_STORE: override });
      expect(JSON.parse(readFileSync(join(f.cwd, "saved.json"), "utf8"))).toMatchObject({
        token: "new",
        storeUrl: override,
      });
      expect(readFileSync(join(f.cwd, "requests.txt"), "utf8")).toContain(
        `${override}/api/console/auth/cli-config`,
      );
    },
  );

  test.each(["environment", "stored"])(
    "local pack stays unsigned while Store publish signs with the %s key",
    async (source) => {
      const f = fixture();
      const env = {
        MENTRA_CLI_TOKEN: "test-token",
        [source === "environment" ? "MENTRA_MINIAPP_SIGNING_KEY_JSON" : "MENTRA_TEST_PACKAGE_KEY"]: JSON.stringify(
          generatePackageSigningKey("com.example.fixture"),
        ),
      };
      await cli(f, ["pack", "--no-build"], env);
      const path = join(f.cwd, "build/com.example.fixture-1.0.0.zip");
      expect((await JSZip.loadAsync(readFileSync(path))).file("META-INF/MENTRA.SIG")).toBeNull();
      await cli(f, ["publish", "--no-build", "--no-submit", "--json"], env);
      expect((await verifySignedBundleArchive(readFileSync(path))).packageName).toBe("com.example.fixture");
    },
  );
});
