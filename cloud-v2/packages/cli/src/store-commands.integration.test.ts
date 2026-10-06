import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { parseListingInput } from "./store-commands";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const done of cleanup.splice(0)) done();
});

async function fixture(status?: string, differentBytes = false, workspaceIds = ["ws_1"]) {
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
  // The workspace each request selected, kept apart from `requests` so those stay {method, path, body}.
  const workspaceHeaders: Array<{ method: string; path: string; workspaceId: string | null }> = [];
  const workspaces = workspaceIds.map((workspaceId) => ({ workspaceId, name: `Team ${workspaceId}` }));
  const workspaceSummary = (workspace: { workspaceId: string; name: string }) => ({
    organizationId: "org_core",
    ...workspace,
    status: "active",
    authorizationRevision: 1,
    membership: { membershipId: `mem_${workspace.workspaceId}`, role: "owner" },
    capabilities: ["miniapps.credentials.create"],
  });
  let failNextTokenMint = false;
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
      const selection = request.headers.get("x-mentra-workspace-id");
      workspaceHeaders.push({ method: request.method, path, workspaceId: selection });
      // What the Store reports as selected: the requested workspace when the caller belongs to it, else the only one.
      const activeWorkspaceId =
        workspaces.find((workspace) => workspace.workspaceId === selection)?.workspaceId ??
        (workspaces.length === 1 ? workspaces[0]!.workspaceId : null);
      if (path === "/api/console/auth/me")
        return Response.json({
          user: { id: "mentra_user", email: "dev@example.test", name: "Dev" },
          workspaces: workspaces.map(workspaceSummary),
          activeWorkspaceId,
        });
      if (path === "/api/console/workspaces") {
        if (request.method === "GET") return Response.json({ items: workspaces.map(workspaceSummary) });
        const created = { workspaceId: "ws_new", name: (body as { name: string }).name };
        workspaces.push(created);
        return Response.json(workspaceSummary(created), { status: 201 });
      }
      const credentialRoute = path.match(/^\/api\/console\/workspaces\/([^/]+)\/credentials(?:\/([^/]+))?$/);
      if (credentialRoute) {
        const [, workspaceId, credentialId] = credentialRoute;
        if (!workspaces.some((workspace) => workspace.workspaceId === workspaceId))
          return Response.json({ error: "workspace_not_found" }, { status: 404 });
        if (request.method === "DELETE") return new Response(null, { status: 204 });
        const view = {
          credentialId: credentialId ?? "cred_1",
          prefix: "msk",
          name: "CI",
          display: "msk_test_…abcd",
          workspaceId,
          scopes: ["miniapps.publish"],
          packageNames: [],
          expiresAt: null,
        };
        if (request.method === "GET") return Response.json({ items: [view] });
        if (failNextTokenMint) {
          failNextTokenMint = false;
          return Response.json({ error: "temporary_failure" }, { status: 503 });
        }
        const input = body as { name: string; packageNames?: string[]; expiresAt?: string };
        return Response.json(
          {
            credential: { ...view, name: input.name, packageNames: input.packageNames ?? [], expiresAt: input.expiresAt ?? null },
            token: "fixture-secret",
          },
          { status: 201 },
        );
      }
      // Every other console route needs a workspace; with several and none selected the Store asks for one.
      if (path.startsWith("/api/console/") && !activeWorkspaceId)
        return Response.json({ error: "workspace_selection_required" }, { status: 409 });
      if (path === "/api/console/publishing-profile") {
        const profile = { workspaceId: activeWorkspaceId, packagePrefix: "", packagePrefixStatus: "unverified" };
        if (request.method === "GET") return Response.json({ ...profile, packagePrefix: "com.example", packagePrefixStatus: "verified" });
        const packagePrefix = (body as { packagePrefix: string }).packagePrefix;
        if (packagePrefix === "taken.example") return Response.json({ error: "package_prefix_taken" }, { status: 409 });
        return Response.json({ ...profile, packagePrefix });
      }
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
      if (path.endsWith("/publishing-tokens")) {
        if (failNextTokenMint) {
          failNextTokenMint = false;
          return Response.json({ error: "temporary_failure" }, { status: 503 });
        }
        return Response.json({
          token: { id: "key", value: "fixture-secret", permissions: ["miniapps:com.example.app:publish"] },
        });
      }
      return Response.json({ error: "unexpected_request" }, { status: 500 });
    },
  });
  cleanup.push(() => server.stop(true));
  // Bun's test runner can suppress child console output from a repository-root
  // invocation. Capture the CLI's JSON messages independently of that reporter.
  const consolePath = join(cwd, "console-output");
  const consoleErrorPath = join(cwd, "console-error");
  const preload = join(cwd, "capture-console.ts");
  const loginPath = join(cwd, "stored-login.json");
  // The keychain is never touched: a saved login lives in a file this test owns.
  writeFileSync(
    preload,
    `import {appendFileSync, existsSync, readFileSync, writeFileSync} from "node:fs";
Object.defineProperty(Bun, "secrets", {value: {
  get: async ({service}) => service === "mentra-store-cli" && existsSync(${JSON.stringify(loginPath)}) ? readFileSync(${JSON.stringify(loginPath)}, "utf8") : null,
  set: async ({service, value}) => { if (service !== "mentra-store-cli") throw new Error("Unexpected credential write"); writeFileSync(${JSON.stringify(loginPath)}, value); },
}});
console.log = (...args) => appendFileSync(${JSON.stringify(consolePath)}, args.join(" ") + "\\n"); console.error = (...args) => appendFileSync(${JSON.stringify(consoleErrorPath)}, args.join(" ") + "\\n");`,
  );
  const env: Record<string, string> = {};
  let storedLogin = false;
  const cli = async (...args: string[]) => {
    writeFileSync(consolePath, "");
    writeFileSync(consoleErrorPath, "");
    const stdoutPath = join(cwd, "stdout");
    const stderrPath = join(cwd, "stderr");
    const stdoutFd = openSync(stdoutPath, "w");
    const stderrFd = openSync(stderrPath, "w");
    const child = spawn(
      process.execPath,
      ["--preload", preload, new URL("./index.ts", import.meta.url).pathname, ...args],
      {
        cwd,
        env: {
          ...process.env,
          // A stored login replaces the environment token, as for someone who ran `mentra login`.
          MENTRA_CLI_TOKEN: storedLogin ? "" : "fixture-token",
          MENTRA_CLI_WORKSPACE_ID: "",
          MENTRA_STORE_URL: `http://127.0.0.1:${server.port}`,
          MENTRA_MINIAPP_SIGNING_KEY_JSON: "must-not-be-used",
          ...env,
        },
        stdio: ["ignore", stdoutFd, stderrFd],
      },
    );
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on("close", resolve);
        child.on("error", reject);
      });
      return {
        code,
        stdout: readFileSync(consolePath, "utf8"),
        stderr: readFileSync(consoleErrorPath, "utf8") + readFileSync(stderrPath, "utf8"),
      };
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }
  };
  return {
    cwd,
    cli,
    requests,
    workspaceHeaders,
    env,
    /** Act as a person who has run `mentra login`, optionally with a workspace already selected. */
    signIn: (workspaceId?: string, organizationId?: string) => {
      storedLogin = true;
      writeFileSync(
        loginPath,
        JSON.stringify({
          token: "fixture-token",
          workosUserId: "workos_user",
          email: "dev@example.test",
          storeUrl: `http://127.0.0.1:${server.port}`,
          storedAt: new Date().toISOString(),
          ...(workspaceId ? { workspaceId } : {}),
          ...(organizationId ? { organizationId } : {}),
        }),
      );
    },
    savedLogin: () => JSON.parse(readFileSync(loginPath, "utf8")) as { workspaceId?: string; token: string },
    failTokenMint: () => {
      failNextTokenMint = true;
    },
  };
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

test("resuming with default flags preserves the original ZIP instead of rebuilding or repacking", async () => {
  const f = await fixture("draft");
  const zipPath = join(f.cwd, "build/com.example.app-1.0.1.zip");
  const original = readFileSync(zipPath);
  mkdirSync(join(f.cwd, "dist"));
  writeFileSync(join(f.cwd, "dist/miniapp.json"), readFileSync(join(f.cwd, "miniapp.json")));
  writeFileSync(join(f.cwd, "dist/background.js"), "console.log('changed after upload')");
  const result = await f.cli("publish", "--skip-existing", "--publish", "--json");
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).release.status).toBe("published");
  expect(readFileSync(zipPath)).toEqual(original);
  expect(f.requests.some((request) => request.method === "POST" && request.path.endsWith("/releases"))).toBe(false);
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

test.each([{ command: ["admin", "publishing-token", "com.example.app"] }, { command: ["tokens", "create"] }])(
  "failed token mint can be retried with the same output path (%j)",
  async ({ command }) => {
    const f = await fixture();
    const args = [...command, "--name", "CI", "--output", "token"];
    f.failTokenMint();
    expect((await f.cli(...args)).code).toBe(1);
    expect(existsSync(join(f.cwd, "token"))).toBe(false);
    const retry = await f.cli(...args);
    expect(retry.code).toBe(0);
    expect(retry.stdout + retry.stderr).not.toContain("fixture-secret");
    expect(readFileSync(join(f.cwd, "token"), "utf8")).toBe("fixture-secret\n");
    expect(statSync(join(f.cwd, "token")).mode & 0o777).toBe(0o600);
  },
);

const apiRequests = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.requests.filter((request) => !request.path.endsWith("/auth/me")).map((request) => `${request.method} ${request.path}`);

test("workspace list marks the selected workspace and shows the caller's role", async () => {
  const f = await fixture(undefined, false, ["ws_1", "ws_2"]);
  f.signIn("ws_2");
  const result = await f.cli("workspace", "list");
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("  ws_1\tTeam ws_1\towner\n* ws_2\tTeam ws_2\towner\n");
});

test("workspace list marks the workspace the Store reports when none is selected", async () => {
  const f = await fixture();
  f.signIn();
  const result = await f.cli("workspace", "list");
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("* ws_1\tTeam ws_1\towner\n");
});

test("workspace use stores the selection, which later commands send", async () => {
  const f = await fixture(undefined, false, ["ws_1", "ws_2"]);
  f.signIn();
  const used = await f.cli("workspace", "use", "ws_2");
  expect(used.code).toBe(0);
  expect(used.stdout).toBe("Using Team ws_2 (ws_2)\n");
  expect(f.savedLogin()).toMatchObject({ workspaceId: "ws_2", token: "fixture-token" });

  const listed = await f.cli("workspace", "list");
  expect(listed.stdout).toContain("* ws_2\tTeam ws_2");
  expect(f.workspaceHeaders.at(-1)).toMatchObject({ path: "/api/console/auth/me", workspaceId: "ws_2" });
  const whoami = await f.cli("whoami");
  expect(whoami.stdout).toContain("Workspace: ws_2");
});

test("whoami labels the WorkOS organization id as WorkOS's, not as the Core organization", async () => {
  const f = await fixture(undefined, false, ["ws_1"]);
  f.signIn("ws_1", "org_workos_fixture");
  const whoami = await f.cli("whoami");
  expect(whoami.code).toBe(0);
  expect(whoami.stdout).toContain("WorkOS organization: org_workos_fixture\n");
  expect(whoami.stdout).not.toMatch(/^Organization:/m);
});

test("workspace use refuses a workspace the caller does not belong to", async () => {
  const f = await fixture(undefined, false, ["ws_1", "ws_2"]);
  f.signIn("ws_1");
  const result = await f.cli("workspace", "use", "ws_elsewhere");
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("You do not have access to that workspace");
  expect(f.savedLogin().workspaceId).toBe("ws_1");
});

test("workspace show prints the workspace with its publishing profile", async () => {
  const f = await fixture(undefined, false, ["ws_1", "ws_2"]);
  f.signIn("ws_2");
  const result = await f.cli("workspace", "show");
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Workspace: Team ws_2 (ws_2)");
  expect(result.stdout).toContain("Role: owner");
  expect(result.stdout).toContain("Package prefix: com.example");
  expect(result.stdout).toContain("Prefix status: verified");
  expect(f.workspaceHeaders.find((request) => request.path === "/api/console/publishing-profile")).toMatchObject({
    method: "GET",
    workspaceId: "ws_2",
  });
});

test("workspace show asks for a selection instead of guessing among several workspaces", async () => {
  const f = await fixture(undefined, false, ["ws_1", "ws_2"]);
  f.signIn();
  const result = await f.cli("workspace", "show");
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("No workspace selected. Run `mentra workspace list`");
  expect(f.requests.some((request) => request.path === "/api/console/publishing-profile")).toBe(false);
});

test("workspace create makes the workspace, selects it and leaves the prefix alone when none is given", async () => {
  const f = await fixture();
  f.signIn("ws_1");
  const result = await f.cli("workspace", "create", "New Team");
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Workspace created: New Team (ws_new)");
  expect(f.requests.find((request) => request.method === "POST")).toEqual({
    method: "POST",
    path: "/api/console/workspaces",
    body: { name: "New Team" },
  });
  // A stale selection is not sent with the create.
  expect(f.workspaceHeaders.find((request) => request.method === "POST")?.workspaceId).toBeNull();
  expect(f.requests.some((request) => request.path === "/api/console/publishing-profile")).toBe(false);
  expect(f.savedLogin().workspaceId).toBe("ws_new");
});

test("workspace create --package-prefix sets the prefix on the new workspace", async () => {
  const f = await fixture();
  f.signIn("ws_1");
  const result = await f.cli("workspace", "create", "New Team", "--package-prefix", "com.neworg");
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Workspace created: New Team (ws_new)");
  expect(result.stdout).toContain("Package prefix: com.neworg (unverified)");
  expect(f.requests.filter((request) => request.method !== "GET")).toEqual([
    { method: "POST", path: "/api/console/workspaces", body: { name: "New Team" } },
    { method: "PUT", path: "/api/console/publishing-profile", body: { packagePrefix: "com.neworg" } },
  ]);
  expect(f.workspaceHeaders.find((request) => request.method === "PUT")?.workspaceId).toBe("ws_new");
  expect(f.savedLogin().workspaceId).toBe("ws_new");
});

test("workspace create keeps the new workspace selected when its prefix is refused", async () => {
  const f = await fixture();
  f.signIn("ws_1");
  const result = await f.cli("workspace", "create", "New Team", "--package-prefix", "taken.example");
  expect(result.code).toBe(1);
  expect(result.stdout).toContain("Workspace created: New Team (ws_new)");
  expect(result.stderr).toContain("package prefix was not set");
  expect(result.stderr).toContain("package_prefix_taken");
  expect(f.savedLogin().workspaceId).toBe("ws_new");
});

test("tokens list, create and revoke go through the active workspace's credentials", async () => {
  const f = await fixture(undefined, false, ["ws_1", "ws_2"]);
  f.env.MENTRA_CLI_WORKSPACE_ID = "ws_2";

  const listed = await f.cli("tokens", "list");
  expect(listed.code).toBe(0);
  expect(JSON.parse(listed.stdout).items[0]).toMatchObject({ credentialId: "cred_1", prefix: "msk" });

  const created = await f.cli(
    "tokens",
    "create",
    "--name",
    "Deploy",
    "--package",
    "com.example.one",
    "--package",
    "com.example.two",
    "--expires",
    "2030-01-01T00:00:00Z",
    "--output",
    "token",
  );
  expect(created.code).toBe(0);
  expect(created.stdout + created.stderr).not.toContain("fixture-secret");
  expect(JSON.parse(created.stdout)).toMatchObject({
    credentialId: "cred_1",
    packageNames: ["com.example.one", "com.example.two"],
    secretFile: "token",
  });
  expect(readFileSync(join(f.cwd, "token"), "utf8")).toBe("fixture-secret\n");
  expect(statSync(join(f.cwd, "token")).mode & 0o777).toBe(0o600);

  const revoked = await f.cli("tokens", "revoke", "cred_9");
  expect(revoked.code).toBe(0);
  expect(JSON.parse(revoked.stdout)).toEqual({ ok: true, credentialId: "cred_9" });

  expect(apiRequests(f)).toEqual([
    "GET /api/console/workspaces/ws_2/credentials",
    "POST /api/console/workspaces/ws_2/credentials",
    "DELETE /api/console/workspaces/ws_2/credentials/cred_9",
  ]);
  expect(f.requests.find((request) => request.method === "POST")?.body).toEqual({
    name: "Deploy",
    packageNames: ["com.example.one", "com.example.two"],
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
  expect(f.workspaceHeaders.filter((request) => request.path.includes("/credentials")).map((request) => request.workspaceId)).toEqual([
    "ws_2",
    "ws_2",
    "ws_2",
  ]);
});

test("tokens use the selection saved by workspace use", async () => {
  const f = await fixture(undefined, false, ["ws_1", "ws_2"]);
  f.signIn();
  expect((await f.cli("workspace", "use", "ws_1")).code).toBe(0);
  expect((await f.cli("tokens", "list")).code).toBe(0);
  expect(apiRequests(f)).toEqual(["GET /api/console/workspaces/ws_1/credentials"]);
});

test("tokens create rejects a bad expiry before reserving the output file", async () => {
  const f = await fixture();
  f.env.MENTRA_CLI_WORKSPACE_ID = "ws_1";
  const result = await f.cli("tokens", "create", "--name", "CI", "--expires", "next tuesday", "--output", "token");
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("--expires must be an ISO 8601 date");
  expect(existsSync(join(f.cwd, "token"))).toBe(false);
  expect(f.requests).toEqual([]);
});

test("several workspaces and none selected: tokens say to run `mentra workspace use <id>` and mint nothing", async () => {
  const f = await fixture(undefined, false, ["ws_1", "ws_2"]);
  const result = await f.cli("tokens", "create", "--name", "CI", "--output", "token");
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Run `mentra workspace use <id>`");
  expect(result.stderr).toContain("ws_1");
  expect(result.stderr).toContain("ws_2");
  expect(existsSync(join(f.cwd, "token"))).toBe(false);
  expect(f.requests.some((request) => request.method === "POST")).toBe(false);
});

test("a Store 409 workspace_selection_required prints the same instruction for any command", async () => {
  const f = await fixture(undefined, false, ["ws_1", "ws_2"]);
  const result = await f.cli("miniapps", "list");
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Run `mentra workspace use <id>`");
  expect(result.stderr).toContain("ws_1\tTeam ws_1");
  expect(result.stderr).toContain("ws_2\tTeam ws_2");
});
