import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";

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
    Object.defineProperty(Bun, "secrets", {value: {get: async ({service}) => { if (service === "mentra-miniapp-publisher-signing") { writeFileSync(${JSON.stringify(join(cwd, "publisher-key-access.txt"))}, "unexpected"); throw new Error("Publisher key must not be accessed"); } return null; },
    set: async () => { throw new Error("Unexpected credential write"); }}});
    globalThis.fetch = async (input, options) => {
      const url = String(input);
      appendFileSync(${JSON.stringify(join(cwd, "requests.txt"))}, url + "\\n");
      if (url.endsWith("/api/console/apps")) return Response.json({app: {}});
      if (url.endsWith("/releases")) {
        const upload = options.body.get("bundle");
        writeFileSync(${JSON.stringify(join(cwd, "uploaded.zip"))}, new Uint8Array(await upload.arrayBuffer()));
        return Response.json({release: {id: "release", version: "1.0.0", status: "draft", releaseTrack: "stable"}});
      }
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
        MENTRA_CORE_URL: "",
        MENTRA_STORE_URL: "https://catalog.example.test",
        MENTRA_CLI_HOME: join(f.cwd, "keys"),
        MENTRA_CLI_TOKEN: "",
        MENTRA_CLI_OIDC_ISSUER: "",
        MENTRA_CLI_CLIENT_ID: "",
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

describe("CLI targets and publication", () => {
  test.each([
    ["mentra", "Store: https://api.apps.mentraglass.com"],
    ["mentra:local", "Store: http://localhost:3003"],
    ["mentra:dev", "Store: https://api.apps.dev.mentraglass.com"],
    ["mentra:staging", "Core: https://core.staging.us-west-2.mentraglass.com"],
    ["mentra:prod", "Store: https://api.apps.mentraglass.com"],
  ])("%s targets %s without Doppler", async (scriptName, target) => {
    const f = fixture();
    // A shortcut wins over a Store or Core a developer may have exported; plain `mentra` uses the default.
    const exported =
      scriptName === "mentra"
        ? { MENTRA_STORE_URL: "", MENTRA_CORE_URL: "" }
        : { MENTRA_STORE_URL: "https://exported-store.example.test", MENTRA_CORE_URL: "https://exported-core.example.test" };
    const stdout = await cli(f, ["whoami"], { ...exported, MENTRA_CLI_TOKEN: "msk_test" }, scriptName);
    expect(stdout).toContain(`${target}\n`);
    expect(existsSync(join(f.cwd, "requests.txt"))).toBe(false);
  });

  test.each([false, true])("publish uploads unsigned bytes with configured keys: %s", async (configured) => {
    const f = fixture();
    const env = {
      MENTRA_CLI_TOKEN: "test-token",
      MENTRA_MINIAPP_SIGNING_KEY_JSON: configured ? "must-not-be-read" : "",
      MENTRA_MINIAPP_SIGNING_KEY_FILE: configured ? join(f.cwd, "must-not-be-read.json") : "",
    };
    await cli(f, ["pack", "--no-build"], env);
    await cli(f, ["publish", "--no-build", "--no-submit", "--json"], env);
    const path = join(f.cwd, "build/com.example.fixture-1.0.0.zip");
    const uploaded = readFileSync(join(f.cwd, "uploaded.zip"));
    expect(uploaded).toEqual(readFileSync(path));
    expect((await JSZip.loadAsync(uploaded)).file("META-INF/MENTRA.SIG")).toBeNull();
    expect(existsSync(join(f.cwd, "publisher-key-access.txt"))).toBe(false);
    expect(readFileSync(join(f.cwd, "requests.txt"), "utf8")).not.toContain("/submit");

    // Reuse the unsigned archive without repacking or changing its bytes.
    await cli(f, ["publish", "--no-build", "--no-pack", "--no-submit"], env);
    expect(readFileSync(join(f.cwd, "uploaded.zip"))).toEqual(uploaded);
  });
});
