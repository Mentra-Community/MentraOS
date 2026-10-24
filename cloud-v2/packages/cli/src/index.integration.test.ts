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
    globalThis.fetch = async (input) => {
      const url = String(input);
      appendFileSync(${JSON.stringify(join(cwd, "requests.txt"))}, url + "\\n");
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
  { mayFail = false }: { mayFail?: boolean } = {},
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
        MENTRA_CORE_URL: "https://core.example.test",
        MENTRA_CLI_HOME: join(f.cwd, "keys"),
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
  if (mayFail) return `${stdout}${stderr}`;
  if (code !== 0) throw new Error(`CLI exited ${code}: ${stdout} ${stderr}`);
  expect(code).toBe(0);
  return stdout;
}

describe("CLI targets and packing", () => {
  test.each([
    ["mentra", "https://core.mentraglass.com"],
    ["mentra:local", "http://localhost:3000"],
    ["mentra:dev", "https://core.dev.us-west-2.mentraglass.com"],
    ["mentra:staging", "https://core.staging.us-west-2.mentraglass.com"],
    ["mentra:prod", "https://core.mentraglass.com"],
  ])("%s signs in at %s without Doppler", async (scriptName, core) => {
    const f = fixture();
    // A shortcut wins over a Core a developer may have exported; plain `mentra` uses the default.
    const exported = scriptName === "mentra" ? { MENTRA_CORE_URL: "" } : { MENTRA_CORE_URL: "https://exported-core.example.test" };
    // The fixture refuses every request, so sign-in stops at its first one: asking that Core for its sign-in server.
    const output = await cli(f, ["login", "--no-browser"], exported, scriptName, { mayFail: true });
    expect(output).toContain(`Could not reach ${core}`);
    expect(readFileSync(join(f.cwd, "requests.txt"), "utf8")).toBe(`${core}/api/cli/config\n`);
  });

  test("pack leaves the bundle unsigned and never reads the configured signing keys without --sign", async () => {
    const f = fixture();
    await cli(f, ["pack", "--no-build"], {
      MENTRA_MINIAPP_SIGNING_KEY_JSON: "must-not-be-read",
      MENTRA_MINIAPP_SIGNING_KEY_FILE: join(f.cwd, "must-not-be-read.json"),
    });
    const bundle = readFileSync(join(f.cwd, "build/com.example.fixture-1.0.0.zip"));
    expect((await JSZip.loadAsync(bundle)).file("META-INF/MENTRA.SIG")).toBeNull();
    expect(existsSync(join(f.cwd, "publisher-key-access.txt"))).toBe(false);
    expect(existsSync(join(f.cwd, "requests.txt"))).toBe(false);
  });
});
