import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { parseListingInput } from "./store-commands";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const done of cleanup.splice(0)) done();
});

async function fixture(status?: string, differentBytes = false) {
  const cwd = mkdtempSync(join(tmpdir(), "mentra-store-cli-"));
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  const manifest = {
    packageName: "com.example.app",
    version: "1.0.1",
    name: "Fixture",
    entry: { background: "background.js" },
  };
  writeFileSync(join(cwd, "miniapp.json"), JSON.stringify(manifest));
  const zip = new JSZip()
    .file("miniapp.json", JSON.stringify(manifest))
    .file("background.js", "console.log('fixture')");
  const bytes = await zip.generateAsync({ type: "uint8array" });
  mkdirSync(join(cwd, "build"));
  writeFileSync(join(cwd, "build/com.example.app-1.0.1.zip"), bytes);
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  let release = {
    id: "release",
    version: "1.0.1",
    releaseTrack: "stable",
    status: status ?? "draft",
    bundleSha256: differentBytes ? "different" : createHash("sha256").update(bytes).digest("hex"),
  };
  const image = Buffer.from("test-image");
  writeFileSync(join(cwd, "icon.png"), image);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      expect(request.headers.get("authorization")).toBe("Bearer fixture-token");
      let body: unknown;
      if (request.headers.get("content-type")?.includes("multipart/form-data")) {
        const form = await request.formData();
        expect(Buffer.from(await (form.get("bundle") as File).arrayBuffer())).toEqual(Buffer.from(bytes));
      } else if (request.method !== "GET" && request.headers.get("content-type")) body = await request.json();
      requests.push({ method: request.method, path, body });
      if (path === "/api/console/apps") return Response.json({ app: {} });
      if (path.endsWith("/releases"))
        return request.method === "GET"
          ? Response.json({ releases: status ? [release] : [] })
          : Response.json({ release });
      if (path.endsWith("/submit")) {
        release = { ...release, status: "submitted" };
        return Response.json({ release });
      }
      if (path.endsWith("/publish")) {
        release = { ...release, status: "published" };
        return Response.json({ release });
      }
      if (path.endsWith("/listing"))
        return Response.json({
          listing: {
            iconAssetId: "icon",
            coverAssetId: null,
            screenshotAssetIds: [],
            assets: [{ id: "icon", role: "store_icon", sha256: createHash("sha256").update(image).digest("hex") }],
            ...((body as object) ?? {}),
          },
        });
      if (path.endsWith("/publishing-tokens"))
        return Response.json({
          token: { id: "key", value: "fixture-secret", permissions: ["miniapps:com.example.app:publish"] },
        });
      return Response.json({ error: "unexpected_request" }, { status: 500 });
    },
  });
  cleanup.push(() => server.stop(true));
  // Bun's test runner can suppress child console output from a repository-root
  // invocation. Capture the CLI's JSON messages independently of that reporter.
  const consolePath = join(cwd, "console-output");
  const consoleErrorPath = join(cwd, "console-error");
  const preload = join(cwd, "capture-console.ts");
  writeFileSync(preload, `import {appendFileSync} from "node:fs"; console.log = (...args) => appendFileSync(${JSON.stringify(consolePath)}, args.join(" ") + "\\n"); console.error = (...args) => appendFileSync(${JSON.stringify(consoleErrorPath)}, args.join(" ") + "\\n");`);
  const cli = async (...args: string[]) => {
    writeFileSync(consolePath, "");
    writeFileSync(consoleErrorPath, "");
    const stdoutPath = join(cwd, "stdout");
    const stderrPath = join(cwd, "stderr");
    const stdoutFd = openSync(stdoutPath, "w");
    const stderrFd = openSync(stderrPath, "w");
    const child = spawn(process.execPath, ["--preload", preload, new URL("./index.ts", import.meta.url).pathname, ...args], {
      cwd,
      env: {
        ...process.env,
        MENTRA_CLI_TOKEN: "fixture-token",
        MENTRA_STORE_URL: `http://127.0.0.1:${server.port}`,
        MENTRA_MINIAPP_SIGNING_KEY_JSON: "must-not-be-used",
      },
      stdio: ["ignore", stdoutFd, stderrFd],
    });
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on("close", resolve);
        child.on("error", reject);
      });
      return { code, stdout: readFileSync(consolePath, "utf8"), stderr: readFileSync(consoleErrorPath, "utf8") + readFileSync(stderrPath, "utf8") };
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }
  };
  return { cwd, cli, requests };
}

test("listing updates preserve multiline descriptions and legal links through the CLI", async () => {
  const f = await fixture();
  const listing = {
    longDescription: "First paragraph.\n\nSecond paragraph.",
    privacyPolicyUrl: "https://example.com/privacy",
    supportUrl: "https://example.com/contact",
    categories: ["productivity"],
  };
  writeFileSync(join(f.cwd, "listing.json"), JSON.stringify(listing));
  const result = await f.cli("listing", "update", "com.example.app", "--file", "listing.json");
  expect(result.code).toBe(0);
  expect(f.requests).toEqual([{ method: "PUT", path: "/api/console/apps/com.example.app/listing", body: listing }]);
  expect(() => parseListingInput({ privacyUrl: "typo" })).toThrow("Invalid listing field");
  expect(() => parseListingInput({ categories: [42] })).toThrow();
});

test("unchanged selected artwork is not uploaded again", async () => {
  const f = await fixture();
  const result = await f.cli(
    "listing",
    "assets",
    "upload",
    "com.example.app",
    "icon.png",
    "--role",
    "store_icon",
    "--skip-existing",
  );
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).skipped).toBe(true);
  expect(f.requests.every((request) => request.method === "GET")).toBe(true);
});

test.each([undefined, "draft", "submitted", "accepted"])(
  "publication resumes %s without reuploading existing bundles",
  async (status) => {
    const f = await fixture(status);
    const result = await f.cli("publish", "--no-build", "--no-pack", "--skip-existing", "--publish", "--json");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).release.status).toBe("published");
    expect(
      f.requests.filter((request) => request.method === "POST" && request.path.endsWith("/releases")),
    ).toHaveLength(status ? 0 : 1);
    expect(f.requests.some((request) => request.path.endsWith("/submit"))).toBe(!status || status === "draft");
  },
);

test("published versions skip and conflicting unfinished versions fail without publication", async () => {
  const published = await fixture("published");
  const skipped = await published.cli("publish", "--skip-existing", "--publish", "--json");
  expect(skipped.code).toBe(0);
  expect(JSON.parse(skipped.stdout).skipped).toBe(true);
  expect(published.requests.some((request) => request.path.endsWith("/publish"))).toBe(false);
  const conflicting = await fixture("draft", true);
  const result = await conflicting.cli("publish", "--no-build", "--no-pack", "--skip-existing", "--publish");
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("different bundle bytes");
  expect(
    conflicting.requests.some((request) => request.path.endsWith("/publish") || request.path.endsWith("/submit")),
  ).toBe(false);
});

test("publishing token writes a private new file, keeps secret out of output, and refuses overwrite", async () => {
  const f = await fixture();
  const args = ["admin", "publishing-token", "com.example.app", "--name", "CI", "--output", "token"];
  const result = await f.cli(...args);
  expect(result.code).toBe(0);
  expect(result.stdout + result.stderr).not.toContain("fixture-secret");
  expect(readFileSync(join(f.cwd, "token"), "utf8")).toBe("fixture-secret\n");
  expect(statSync(join(f.cwd, "token")).mode & 0o777).toBe(0o600);
  expect((await f.cli(...args)).code).toBe(1);
  expect(f.requests.filter((request) => request.path.endsWith("/publishing-tokens"))).toHaveLength(1);
});
