import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { GithubTestBuildGateway, readRequestZip, readTestMetadata } from "./test-builds.service";
import { TEST_ROUTINES, testBuildQuerySchema, testDispatchInputSchema, testRoutinePlatform, type TestDispatchInput, type TestRoutineId } from "../types/test-dispatch.types";
import { TestRunGithubApp } from "./test-run-github-app";

const REPO = "Mentra-Community/MentraOS";
const API = `https://api.github.com/repos/${REPO}`;
const CDN = `https://artifactscdn.mentraglass.com/${REPO}/releases/`;
const HEAD = "a".repeat(40), BASE = "b".repeat(40), MERGE = "c".repeat(40), HASH = "d".repeat(64);
const appCredentials = { appId: "12345", installationId: "67890", privateKey:
  generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs1" }).toString() };
const input: TestDispatchInput = { source: { channel: "pr", prNumber: 12, buildRunId: 50, publicationAttempt: 1 },
  routineId: "no-glasses", archiveSha256: HASH, idempotencyKey: "ad616c04-c5e5-4dcd-b7c4-d9d4a626166d" };
const run = (extra = {}) => ({ id: 50, run_attempt: 1, head_sha: HEAD, head_branch: "candidate", path: ".github/workflows/mentra-app-ios-build.yml",
  event: "pull_request", status: "completed", conclusion: "success", created_at: "2026-09-23T01:00:00Z", display_title: "Candidate",
  repository: { full_name: REPO }, head_repository: { full_name: REPO }, ...extra });
const pr = { number: 12, state: "open", title: "Candidate", head: { sha: HEAD, ref: "candidate", repo: { full_name: REPO } }, base: { ref: "dev" } };
const jobs = ["build", "publish"].map((name, index) => ({ id: index + 1, name, run_attempt: 1, status: "completed", conclusion: "success",
  started_at: "2026-09-23T01:00:00Z", completed_at: "2026-09-23T01:10:00Z" }));
function fixture() {
  const rows = new Map<string, unknown>();
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const value = rows.get(`${init?.method ?? "GET"} ${url}`) ?? rows.get(url);
    if (value instanceof Error) throw value;
    if (value instanceof Response) return value.clone();
    return value === undefined ? new Response("missing", { status: 404 }) : Response.json(value);
  }) as typeof globalThis.fetch;
  const receipt = { schemaVersion: 2, pr: 12, headSha: HEAD, runId: 50, runAttempt: 1, buildSha: MERGE,
    app: { bundleId: "com.mentra.mentra", teamId: "T5XXXL6N36", backend: "dev", headSha: HEAD, buildSha: MERGE, runId: 50, runAttempt: 1,
      executableSha256: HASH, javascriptSha256: HASH, otaManifestUrl: `${CDN}pr-builds/ota-pr-12-${HEAD}.json` },
    artifacts: { mac: { name: `mentra-ios-mac-pr-12-${HEAD}-50-1.zip`, sha256: HASH, size: 100 } } };
  rows.set(`${API}/pulls/12`, pr);
  rows.set(`${API}/git/ref/heads/dev`, { ref: "refs/heads/dev", object: { type: "commit", sha: BASE } });
  rows.set(`${API}/actions/runs/50/attempts/1`, run());
  rows.set(`${API}/actions/runs/50/jobs?filter=all&per_page=100&page=1`, { total_count: jobs.length, jobs });
  rows.set(`${CDN}pr-builds/mentra-ios-pr-12-${HEAD}-50-1.json`, receipt);
  rows.set(`${CDN}pr-builds/ota-pr-12-${HEAD}.json`, { releaseVersion: `pr-12-${HEAD}` });
  rows.set(`${API}/commits/${MERGE}`, { sha: MERGE, parents: [{ sha: BASE }, { sha: HEAD }] });
  rows.set(`HEAD ${CDN}pr-builds/${receipt.artifacts.mac.name}`, new Response(null, { headers: { "Content-Length": "100" } }));
  return { rows, calls, fetch, receipt, gateway: new GithubTestBuildGateway({ token: "test-only-token", fetch }) };
}

test("strict user input accepts only supported selectors and never a ref, command, URL or repository", () => {
  expect(testDispatchInputSchema.parse(input)).toEqual(input);
  for (const change of [{ source: { ...input.source, ref: "main" } }, { source: { ...input.source, repository: "elsewhere/repo" } },
    { routineId: "shell" }, { command: "anything" }, { archiveSha256: "wrong" }])
    expect(testDispatchInputSchema.safeParse({ ...input, ...change }).success).toBe(false);
  expect(testBuildQuerySchema.safeParse({ channel: "dev", pr: "12" }).success).toBe(false);
  expect(testBuildQuerySchema.safeParse({ channel: "pr" }).success).toBe(false);
  expect(testBuildQuerySchema.parse({ channel: "dev", routineId: "no-glasses-android" }).routineId).toBe("no-glasses-android");
  expect(testDispatchInputSchema.parse({ ...input, routineId: "no-glasses-android" }).routineId).toBe("no-glasses-android");
  expect(testBuildQuerySchema.safeParse({ channel: "dev", platform: "android" }).success).toBe(false);
  expect(testBuildQuerySchema.safeParse({ channel: "dev", routineId: "shell" }).success).toBe(false);
});

describe("exact PR build inventory", () => {
  test("a current published build is selectable without a PR label", async () => {
    const f = fixture();
    const selected = await f.gateway.resolve(input.source);
    expect(selected.availability).toBe("available");
    expect(selected.archive?.sha256).toBe(HASH);
    expect(selected.routines.filter(routine => routine.available).map(routine => routine.id)).toEqual(["no-glasses"]);
    expect(f.calls.every(call => !call.init?.method || ["GET", "HEAD"].includes(call.init.method))).toBe(true);
  });
  test("closed/forked PR and mismatched exact attempts are refused", async () => {
    const f = fixture();
    f.rows.set(`${API}/pulls/12`, { ...pr, state: "closed" });
    await expect(f.gateway.resolve(input.source)).rejects.toThrow("open same-repository");
    f.rows.set(`${API}/pulls/12`, pr);
    f.rows.set(`${API}/actions/runs/50/attempts/1`, run({ run_attempt: 2 }));
    await expect(f.gateway.resolve(input.source)).rejects.toThrow("selected source");
  });
  test("stale base, bad receipt binding, wrong manifest and unavailable archive cannot enable dispatch", async () => {
    for (const scenario of ["base", "receipt", "manifest", "archive"]) {
      const f = fixture();
      if (scenario === "base") f.rows.set(`${API}/commits/${MERGE}`, { sha: MERGE, parents: [{ sha: HEAD }, { sha: HEAD }] });
      if (scenario === "receipt") f.receipt.app.runId = 51;
      if (scenario === "manifest") f.rows.set(`${CDN}pr-builds/ota-pr-12-${HEAD}.json`, { releaseVersion: "another-build" });
      if (scenario === "archive") f.rows.delete(`HEAD ${CDN}pr-builds/${f.receipt.artifacts.mac.name}`);
      const selected = await f.gateway.resolve(input.source);
      expect(selected.availability).toBe("unavailable");
      expect(selected.routines.every(routine => !routine.available)).toBe(true);
    }
  });
  test("notification failure retains a successful publication, but unfinished builds do not", async () => {
    const f = fixture();
    f.rows.set(`${API}/actions/runs/50/attempts/1`, run({ conclusion: "failure" }));
    expect((await f.gateway.resolve(input.source)).availability).toBe("available");
    f.rows.set(`${API}/actions/runs/50/attempts/1`, run({ status: "in_progress" }));
    expect((await f.gateway.resolve(input.source)).availability).toBe("unavailable");
  });
  test("exact resolution preserves transient metadata and archive failures while inventory remains readable", async () => {
    for (const failure of [new Response("busy", { status: 429 }), new Response("unavailable", { status: 503 }), new Error("Network timeout")]) {
      for (const location of ["metadata", "archive"]) {
        const f = fixture();
        f.rows.set(`${API}/actions/workflows/mentra-app-ios-build.yml/runs?event=pull_request&head_sha=${HEAD}&per_page=10`, { workflow_runs: [run()] });
        f.rows.set(location === "metadata" ? `${CDN}pr-builds/mentra-ios-pr-12-${HEAD}-50-1.json`
          : `HEAD ${CDN}pr-builds/${f.receipt.artifacts.mac.name}`, failure);
        await expect(f.gateway.resolve(input.source)).rejects.toThrow(failure instanceof Error ? "Network timeout" : /unavailable/);
        expect((await f.gateway.inventory({ channel: "pr", pr: 12 }))[0]!.availability).toBe("unavailable");
      }
    }
  });
});

// A staging-targeted PR: its merge parent is the staging tip and its app uses staging.
function targetStaging(f: { rows: Map<string, unknown>; receipt: { app: { backend: string } } }, receipt = f.receipt) {
  f.rows.set(`${API}/pulls/12`, { ...pr, base: { ref: "staging" } });
  f.rows.delete(`${API}/git/ref/heads/dev`);
  f.rows.set(`${API}/git/ref/heads/staging`, { ref: "refs/heads/staging", object: { type: "commit", sha: BASE } });
  receipt.app.backend = "staging";
}

describe("exact staging PR build inventory", () => {
  test("an open staging PR selects its exact Mac build merged with the current staging tip", async () => {
    const f = fixture();
    targetStaging(f);
    f.rows.set(`${API}/actions/workflows/mentra-app-ios-build.yml/runs?event=pull_request&head_sha=${HEAD}&per_page=10`, { workflow_runs: [run()] });
    for (const build of [await f.gateway.resolve(input.source), ...(await f.gateway.inventory({ channel: "pr", pr: 12 }))]) {
      expect(build.availability).toBe("available");
      expect(build.source).toEqual(input.source);
      expect(build.archive?.sha256).toBe(HASH);
    }
    expect(f.calls.some(call => call.url.endsWith("/git/ref/heads/dev"))).toBe(false);
  });
  test("backend mismatches, a stale staging merge, and non-admitted bases are refused", async () => {
    for (const scenario of ["dev-app-on-staging", "staging-app-on-dev", "moved-staging-tip", "prod-app"]) {
      const f = fixture();
      if (scenario !== "staging-app-on-dev") targetStaging(f);
      if (scenario === "dev-app-on-staging") f.receipt.app.backend = "dev";
      if (scenario === "staging-app-on-dev") f.receipt.app.backend = "staging";
      if (scenario === "moved-staging-tip") f.rows.set(`${API}/git/ref/heads/staging`, { ref: "refs/heads/staging", object: { type: "commit", sha: "e".repeat(40) } });
      if (scenario === "prod-app") f.receipt.app.backend = "prod";
      f.rows.set(`${API}/actions/workflows/mentra-app-ios-build.yml/runs?event=pull_request&head_sha=${HEAD}&per_page=10`, { workflow_runs: [run()] });
      const selected = (await f.gateway.inventory({ channel: "pr", pr: 12 }))[0]!;
      expect(selected.availability).toBe("unavailable");
      expect(selected.routines.every(routine => !routine.available)).toBe(true);
      // Exact selection refuses the same candidate rather than dispatching it.
      if (scenario !== "prod-app") expect((await f.gateway.resolve(input.source)).availability).toBe("unavailable");
      else await expect(f.gateway.resolve(input.source)).rejects.toThrow();
    }
    for (const base of ["main", "feature"]) {
      const f = fixture();
      f.rows.set(`${API}/pulls/12`, { ...pr, base: { ref: base } });
      await expect(f.gateway.resolve(input.source)).rejects.toThrow("targeting dev or staging");
      expect(f.calls.some(call => call.url.includes("/git/ref/"))).toBe(false);
    }
  });
  test("a staging Android PR validates its own staging APK receipt", async () => {
    const f = androidPrFixture();
    targetStaging(f, f.receipt);
    const build = (await f.gateway.inventory({ channel: "pr", pr: 12, routineId: "no-glasses-android" }))[0]!;
    expect(build.availability).toBe("available");
    expect(build.routines.filter(routine => routine.available).map(routine => routine.id)).toEqual(["no-glasses-android"]);
    f.receipt.app.backend = "dev";
    expect((await f.gateway.inventory({ channel: "pr", pr: 12, routineId: "no-glasses-android" }))[0]!.availability).toBe("unavailable");
  });
});

function releaseFixture(channel: "dev" | "staging", attempt = 1) {
  const f = fixture(), releaseChannel = channel === "dev" ? "dev" : "beta", identity = `3.3.0-${releaseChannel}.325`, tag = "mentra-builds-v3.3.0";
  const releaseRun = run({ run_attempt: attempt, event: "push", head_branch: channel, path: ".github/workflows/coordinated-release.yml" });
  const publicationJobs = [{ ...jobs[0]!, name: "Finalize immutable release bill of materials", run_attempt: attempt,
    steps: [{ name: "Publish immutable plan, package, and manifest assets", status: "completed", conclusion: "success" }] }];
  f.rows.set(`${API}/actions/runs/50/jobs?filter=all&per_page=100&page=1`, { total_count: publicationJobs.length, jobs: publicationJobs });
  f.rows.set(`${API}/actions/runs/50/attempts/${attempt}`, releaseRun);
  f.rows.set(`${API}/actions/workflows/coordinated-release.yml/runs?branch=${channel}&per_page=10`, { workflow_runs: [releaseRun] });
  f.rows.set(`${API}/actions/runs/50/artifacts?per_page=100`, { artifacts: [{ name: `coordinated-release-plan-mentra-${identity}`, expired: false,
    workflow_run: { id: 50, head_sha: HEAD } }] });
  f.rows.set(`${CDN}${tag}/mentra-release-plan-${identity}.json`, { releaseIdentity: identity, sourceCommit: HEAD, channel: releaseChannel,
    artifactContainerTag: tag, native: { buildNumber: 303000325, marketingVersion: "3.3.0" }, artifactNames: { otaManifest: `mentra-live-ota-${identity}.json` } });
  f.rows.set(`${CDN}${tag}/mentraos-${identity}-apple-downloads.json`, { schemaVersion: 1, releaseIdentity: identity, sourceCommit: HEAD,
    app: { bundleId: "com.mentra.mentra", headSha: HEAD, backend: channel, build: "303000325", version: "3.3.0",
      otaManifestUrl: `${CDN}${tag}/mentra-live-ota-${identity}.json`, executableSha256: HASH, javascriptSha256: HASH },
    artifacts: { mac: { name: `mentraos-${identity}-mac.zip`, size: 100, sha256: HASH } } });
  f.rows.set(`${CDN}${tag}/mentra-live-ota-${identity}.json`, { releaseVersion: identity });
  f.rows.set(`HEAD ${CDN}${tag}/mentraos-${identity}-mac.zip`, new Response(null, { headers: { "Content-Length": "100" } }));
  return { ...f, identity, publicationJobs, releaseRun };
}

describe("a local test's recorded published Mac app", () => {
  const recorded = { producerRunId: 50, executableSha256: HASH, javascriptSha256: HASH, headSha: HEAD };
  for (const channel of ["dev", "staging"] as const) test(`resolves the exact old ${channel} producer and checks both installed hashes`, async () => {
    const f = releaseFixture(channel);
    f.rows.set(`${API}/actions/runs/50`, f.releaseRun);
    const gateway = new GithubTestBuildGateway({ token: "test-only", fetch: f.fetch, channels: [channel], routines: ["notes-phone"] });
    const build = await gateway.resolveRecordedApp({ ...recorded, channel }, "notes-phone");
    expect(build.source).toEqual({ channel, buildRunId: 50, publicationAttempt: 1 });
    expect(build.app).toEqual({ executableSha256: HASH, javascriptSha256: HASH });
    expect(build.archive?.sha256).toBe(HASH);
    expect(build.routines.find(row => row.id === "notes-phone")).toEqual({ id: "notes-phone", available: true });
    expect(f.calls.some(call => /\/workflows\/|\/pulls\//.test(call.url))).toBe(false);
    expect(f.calls.every(call => !call.init?.method || ["GET", "HEAD"].includes(call.init.method))).toBe(true);
    for (const field of ["executableSha256", "javascriptSha256"] as const)
      await expect(gateway.resolveRecordedApp({ ...recorded, channel, [field]: "e".repeat(64) }, "notes-phone"))
        .rejects.toThrow("Published app bytes differ");
  });
  test("producer, source, channel, explicit attempt and repository cannot be substituted", async () => {
    for (const change of [{ id: 51 }, { head_sha: BASE }, { head_branch: "staging" }, { event: "pull_request" },
      { repository: { full_name: "another/repo" } }, { head_repository: { full_name: "another/repo" } },
      { path: ".github/workflows/untrusted.yml" }, { run_attempt: 2 }]) {
      const f = releaseFixture("dev");
      f.rows.set(`${API}/actions/runs/50/attempts/1`, { ...f.releaseRun, ...change });
      await expect(f.gateway.resolveRecordedApp({ ...recorded, channel: "dev", publicationAttempt: 1 }, "notes-phone"))
        .rejects.toThrow("producer");
    }
    const f = releaseFixture("dev");
    await expect(f.gateway.resolveRecordedApp({ ...recorded, channel: "dev" }, "no-glasses-android"))
      .rejects.toThrow("Mac app bytes only");
    expect(f.calls).toEqual([]);
  });
  test("a notification-only retry retains the real publication attempt; an explicitly different attempt refuses", async () => {
    const f = releaseFixture("dev");
    f.rows.set(`${API}/actions/runs/50`, { ...f.releaseRun, run_attempt: 2 });
    f.rows.set(`${API}/actions/runs/50/attempts/2`, { ...f.releaseRun, run_attempt: 2 });
    expect((await f.gateway.resolveRecordedApp({ ...recorded, channel: "dev" }, "notes-phone")).source.publicationAttempt).toBe(1);
    await expect(f.gateway.resolveRecordedApp({ ...recorded, channel: "dev", publicationAttempt: 2 }, "notes-phone"))
      .rejects.toThrow("different publication");
  });
  test("disabled enrollment and missing or ambiguous publication stay unavailable with their existing reasons", async () => {
    const f = releaseFixture("dev"); f.rows.set(`${API}/actions/runs/50`, f.releaseRun);
    const selected = await f.gateway.resolveRecordedApp({ ...recorded, channel: "dev" }, "notes-phone");
    expect(selected.routines.find(row => row.id === "notes-phone")?.available).toBe(false);
    expect(selected.routines.find(row => row.id === "notes-phone")?.reason).toContain("channel is not enabled");
    const enabled = new GithubTestBuildGateway({ token: "test-only", fetch: f.fetch, channels: ["dev"], routines: [] });
    expect((await enabled.resolveRecordedApp({ ...recorded, channel: "dev" }, "notes-phone"))
      .routines.find(row => row.id === "notes-phone")?.reason).toContain("not enabled on the test workers");
    const artifacts = f.rows.get(`${API}/actions/runs/50/artifacts?per_page=100`) as { artifacts: unknown[] };
    artifacts.artifacts.push(artifacts.artifacts[0]);
    const ambiguous = await enabled.resolveRecordedApp({ ...recorded, channel: "dev" }, "notes-phone");
    expect(ambiguous.availability).toBe("unavailable"); expect(ambiguous.reason).toContain("ambiguous");
    artifacts.artifacts.pop(); f.rows.delete(`HEAD ${CDN}mentra-builds-v3.3.0/mentraos-${f.identity}-mac.zip`);
    const missing = await enabled.resolveRecordedApp({ ...recorded, channel: "dev" }, "notes-phone");
    expect(missing.availability).toBe("unavailable"); expect(missing.reason).toContain("archive is missing");
  });
});

for (const channel of ["dev", "staging"] as const) test(`${channel} inventories coordinated Mac receipts without fabricating PR provenance`, async () => {
  const f = releaseFixture(channel);
  const builds = await f.gateway.inventory({ channel });
  expect(builds[0]?.availability).toBe("available");
  expect(builds[0]?.release).toBe(f.identity);
  expect(builds[0]?.source).toEqual({ channel, buildRunId: 50, publicationAttempt: 1 });
  expect(builds[0]?.routines[0]?.available).toBe(false);
  expect(builds[0]?.routines[0]?.reason).toContain("not enabled");
  const enabled = new GithubTestBuildGateway({ token: "test-only-token", fetch: f.fetch, channels: ["pr", "dev", "staging"] });
  const available = (await enabled.inventory({ channel }))[0]!;
  expect(available.routines.find(routine => routine.id === "no-glasses")?.available).toBe(true);
  expect(available.routines.find(routine => routine.id === "day1-ota")?.available).toBe(false);
  expect(available.routines.find(routine => routine.id === "day1-ota")?.reason).toContain("not enabled");
  expect(available.routines.find(routine => routine.id === "mentra-call")?.available).toBe(false);
  const commissioned = new GithubTestBuildGateway({ token: "test-only-token", fetch: f.fetch, channels: [channel],
    routines: ["no-glasses", "day1-ota", "mentra-call"] });
  // Every enabled Mac routine is available; a registered Mac routine this deployment does not enable (account-miniapps,
  // livestreamer and the Phone mode routines) stays unavailable.
  expect(Object.fromEntries((await commissioned.inventory({ channel }))[0]!.routines
    .filter(routine => testRoutinePlatform(routine.id) === "ios-on-mac").map(routine => [routine.id, routine.available])))
    .toEqual({ "no-glasses": true, "day1-ota": true, "mentra-call": true, "account-miniapps": false, livestreamer: false,
      "captions-phone": false, "notes-phone": false });
});

for (const channel of ["dev", "staging"] as const) test(`${channel} lists the registered Phone mode routines on Mac builds, available only once a deployment enables them`, async () => {
  const f = releaseFixture(channel);
  for (const routineId of ["captions-phone", "notes-phone"] as const) {
    expect(testRoutinePlatform(routineId)).toBe("ios-on-mac");
    expect(testDispatchInputSchema.parse({ ...input, source: { channel, buildRunId: 50, publicationAttempt: 1 }, routineId }).routineId).toBe(routineId);
    expect(testBuildQuerySchema.parse({ channel, routineId }).routineId).toBe(routineId);
  }
  // The default deployment enables only no-glasses: both stay unavailable, with the ordinary enablement reason.
  const defaults = (await new GithubTestBuildGateway({ token: "test-only-token", fetch: f.fetch, channels: [channel] }).inventory({ channel }))[0]!.routines;
  for (const id of ["captions-phone", "notes-phone"] as const)
    expect(defaults.find(routine => routine.id === id)).toEqual({ id, available: false, reason: "This routine is not enabled on the test workers yet" });
  // Unlike a planned routine, a deployment that enrols them makes the Mac build requestable.
  const enrolled = (await new GithubTestBuildGateway({ token: "test-only-token", fetch: f.fetch, channels: [channel],
    routines: ["captions-phone", "notes-phone"] }).inventory({ channel }))[0]!.routines;
  for (const id of ["captions-phone", "notes-phone"] as const) expect(enrolled.find(routine => routine.id === id)?.available).toBe(true);
});

for (const channel of ["dev", "staging"] as const) test(`${channel} lists the registered Livestreamer routine on Mac builds, available only once a deployment enables it`, async () => {
  const f = releaseFixture(channel);
  expect(testRoutinePlatform("livestreamer")).toBe("ios-on-mac");
  expect(testDispatchInputSchema.parse({ ...input, source: { channel, buildRunId: 50, publicationAttempt: 1 }, routineId: "livestreamer" }).routineId)
    .toBe("livestreamer");
  expect(testBuildQuerySchema.parse({ channel, routineId: "livestreamer" }).routineId).toBe("livestreamer");
  expect(TEST_ROUTINES.find(routine => routine.id === "livestreamer")).not.toHaveProperty("planned");
  // Source registration is not deployment enablement: the default deployment keeps the ordinary enablement reason.
  const defaults = (await new GithubTestBuildGateway({ token: "test-only-token", fetch: f.fetch, channels: [channel] }).inventory({ channel }))[0]!.routines;
  expect(defaults.find(routine => routine.id === "livestreamer")).toEqual({ id: "livestreamer", available: false,
    reason: "This routine is not enabled on the test workers yet" });
  const enrolled = (await new GithubTestBuildGateway({ token: "test-only-token", fetch: f.fetch, channels: [channel],
    routines: ["livestreamer"] }).inventory({ channel }))[0]!.routines;
  expect(enrolled.find(routine => routine.id === "livestreamer")?.available).toBe(true);
});

for (const channel of ["dev", "staging"] as const) test(`${channel} has no planned routine left: enabled routines are available on their own platform, unknown IDs refused`, async () => {
  // Every catalogued routine is registered now, so no `planned` reason remains to override deployment enablement.
  expect(TEST_ROUTINES.filter(routine => "planned" in routine)).toEqual([]);
  const f = releaseFixture(channel);
  const gateway = new GithubTestBuildGateway({ token: "test-only-token", fetch: f.fetch, channels: [channel],
    routines: ["no-glasses", "day1-ota", "mentra-call", "account-miniapps", "connected-glasses", "livestreamer"] });
  const routines = (await gateway.inventory({ channel }))[0]!.routines;
  const row = (id: TestRoutineId) => routines.find(routine => routine.id === id)!;
  expect((["no-glasses", "day1-ota", "mentra-call", "account-miniapps", "livestreamer"] as const).every(id => row(id).available)).toBe(true);
  // Unknown routine IDs are still refused before any inventory or dispatch.
  for (const routineId of ["synthetic-unregistered", "shell"]) {
    expect(testBuildQuerySchema.safeParse({ channel, routineId }).success).toBe(false);
    expect(testDispatchInputSchema.safeParse({ ...input, source: { channel, buildRunId: 50, publicationAttempt: 1 }, routineId }).success).toBe(false);
  }
  // Connected glasses is a registered Android routine: a Mac build reports the platform first, never a Mac run.
  expect(testRoutinePlatform("connected-glasses")).toBe("android");
  expect(row("connected-glasses").available).toBe(false);
  expect(row("connected-glasses").reason).toContain("published Android APK");
});

for (const channel of ["dev", "staging"] as const) test(`${channel} lists registered account-miniapps on its exact Mac build, available only once a deployment enables it`, async () => {
  const f = releaseFixture(channel);
  expect(testRoutinePlatform("account-miniapps")).toBe("ios-on-mac");
  expect(TEST_ROUTINES.find(routine => routine.id === "account-miniapps")).not.toHaveProperty("planned");
  expect(testDispatchInputSchema.parse({ ...input, source: { channel, buildRunId: 50, publicationAttempt: 1 }, routineId: "account-miniapps" }).routineId)
    .toBe("account-miniapps");
  expect(testBuildQuerySchema.parse({ channel, routineId: "account-miniapps" }).routineId).toBe("account-miniapps");
  // Source registration is not deployment enablement: the default workers keep the ordinary enablement reason.
  const defaults = (await new GithubTestBuildGateway({ token: "test-only-token", fetch: f.fetch, channels: [channel] })
    .inventory({ channel, routineId: "account-miniapps" }))[0]!;
  expect(defaults.source).toEqual({ channel, buildRunId: 50, publicationAttempt: 1 });
  expect(defaults.routines.find(routine => routine.id === "account-miniapps")).toEqual({ id: "account-miniapps", available: false,
    reason: "This routine is not enabled on the test workers yet" });
  // An enrolled deployment makes the same exact Mac build requestable; the channel gate still applies.
  const enrolled = (await new GithubTestBuildGateway({ token: "test-only-token", fetch: f.fetch, channels: [channel],
    routines: ["account-miniapps"] }).inventory({ channel, routineId: "account-miniapps" }))[0]!;
  expect(enrolled.platform).toBe("ios-on-mac");
  expect(enrolled.release).toBe(f.identity);
  expect(enrolled.routines.filter(routine => routine.available).map(routine => routine.id)).toEqual(["account-miniapps"]);
  const otherChannel = (await new GithubTestBuildGateway({ token: "test-only-token", fetch: f.fetch, channels: ["pr"],
    routines: ["account-miniapps"] }).inventory({ channel, routineId: "account-miniapps" }))[0]!;
  expect(otherChannel.routines.find(routine => routine.id === "account-miniapps")?.available).toBe(false);
  // Enabled Livestreamer, also registered, is available on the same build; connected-glasses is an Android routine and
  // stays unavailable on a Mac build even when enabled.
  const others = (await new GithubTestBuildGateway({ token: "test-only-token", fetch: f.fetch, channels: [channel],
    routines: ["account-miniapps", "livestreamer", "connected-glasses"] }).inventory({ channel }))[0]!.routines;
  expect(others.filter(routine => routine.available).map(routine => routine.id)).toEqual(["account-miniapps", "livestreamer"]);
});

for (const channel of ["dev", "staging"] as const) test(`${channel} retained artifacts cannot qualify a non-publishing attempt`, async () => {
  for (const scenario of ["earlier-attempt", "later-skipped", "later-failed", "dry-run", "missing-step", "ambiguous-finalizer"]) {
    const f = releaseFixture(channel, 2);
    const published = structuredClone(f.publicationJobs[0]!);
    if (scenario === "earlier-attempt") {
      f.releaseRun.run_attempt = 1;
      f.rows.set(`${API}/actions/runs/50/attempts/1`, f.releaseRun);
      f.publicationJobs.unshift({ ...published, id: 99, run_attempt: 1, conclusion: "skipped", steps: [] });
    }
    if (scenario === "later-skipped" || scenario === "later-failed") {
      f.publicationJobs.unshift({ ...published, id: 99, run_attempt: 1 });
      f.publicationJobs[1]!.conclusion = scenario === "later-skipped" ? "skipped" : "failure";
    }
    if (scenario === "dry-run") f.publicationJobs[0]!.steps[0]!.conclusion = "skipped";
    if (scenario === "missing-step") f.publicationJobs[0]!.steps = [];
    if (scenario === "ambiguous-finalizer") f.publicationJobs.push({ ...published, id: 99 });
    f.rows.set(`${API}/actions/runs/50/jobs?filter=all&per_page=100&page=1`, { total_count: f.publicationJobs.length, jobs: f.publicationJobs });
    const gateway = new GithubTestBuildGateway({ token: "test-only-token", fetch: f.fetch, channels: [channel],
      routines: ["no-glasses", "day1-ota", "mentra-call"] });
    const selected = await gateway.resolve({ channel, buildRunId: 50, publicationAttempt: f.releaseRun.run_attempt });
    const inventoried = (await gateway.inventory({ channel }))[0]!;
    for (const build of [selected, inventoried]) {
      expect(build.availability).toBe("unavailable");
      expect(build.reason).toContain("did not publish immutable assets");
      expect(build.routines.every(routine => !routine.available)).toBe(true);
    }
    expect(f.calls.some(call => call.url.startsWith(CDN) || call.url.includes("/artifacts?"))).toBe(false);
  }
});

for (const channel of ["dev", "staging"] as const) test(`${channel} retains the actual publication through downstream failure and notification-only retries`, async () => {
  for (const conclusion of ["success", "failure"]) for (const clonedJob of [false, true]) {
    const f = releaseFixture(channel);
    f.releaseRun.conclusion = "failure";
    const latest = { ...f.releaseRun, run_attempt: 2, conclusion };
    f.rows.set(`${API}/actions/runs/50/attempts/2`, latest);
    f.rows.set(`${API}/actions/workflows/coordinated-release.yml/runs?branch=${channel}&per_page=10`, { workflow_runs: [latest] });
    if (clonedJob) f.publicationJobs.push({ ...structuredClone(f.publicationJobs[0]!), id: 99, run_attempt: 2 });
    f.rows.set(`${API}/actions/runs/50/jobs?filter=all&per_page=100&page=1`, { total_count: f.publicationJobs.length, jobs: f.publicationJobs });
    const gateway = new GithubTestBuildGateway({ token: "test-only-token", fetch: f.fetch, channels: [channel] });
    const inventoried = (await gateway.inventory({ channel }))[0]!;
    expect(inventoried.availability).toBe("available");
    expect(inventoried.source.publicationAttempt).toBe(1);
    expect(inventoried.routines.find(routine => routine.id === "no-glasses")?.available).toBe(true);
    expect((await gateway.resolve(inventoried.source)).availability).toBe("available");
    await expect(gateway.resolve({ channel, buildRunId: 50, publicationAttempt: 2 }))
      .rejects.toThrow("retained a different publication");
    f.rows.set(`POST ${API}/actions/workflows/request-e2e-routine.yml/dispatches`, {
      workflow_run_id: 70, html_url: `https://github.com/${REPO}/actions/runs/70`, run_url: `${API}/actions/runs/70`,
    });
    await gateway.dispatch({ ...input, source: inventoried.source });
    expect(JSON.parse(String(f.calls.at(-1)!.init?.body)).inputs.source_publication_attempt).toBe("1");
  }
});

test("a new finalizer execution selects its own publication attempt", async () => {
  const f = releaseFixture("dev", 2);
  f.publicationJobs[0]!.started_at = "2026-09-23T02:00:00Z";
  f.publicationJobs[0]!.completed_at = "2026-09-23T02:10:00Z";
  f.publicationJobs.unshift({ ...f.publicationJobs[0]!, id: 99, run_attempt: 1,
    started_at: "2026-09-23T01:00:00Z", completed_at: "2026-09-23T01:10:00Z" });
  f.rows.set(`${API}/actions/runs/50/jobs?filter=all&per_page=100&page=1`, { total_count: f.publicationJobs.length, jobs: f.publicationJobs });
  expect((await f.gateway.inventory({ channel: "dev" }))[0]!.source.publicationAttempt).toBe(2);
  expect((await f.gateway.resolve({ channel: "dev", buildRunId: 50, publicationAttempt: 2 })).availability).toBe("available");
});

test("the actual successful producing retry is available with its original attempt number", async () => {
  const f = releaseFixture("dev", 2);
  f.publicationJobs.unshift({ ...f.publicationJobs[0]!, id: 99, run_attempt: 1, conclusion: "skipped", steps: [] });
  f.rows.set(`${API}/actions/runs/50/jobs?filter=all&per_page=100&page=1`, { total_count: f.publicationJobs.length, jobs: f.publicationJobs });
  const selected = await f.gateway.resolve({ channel: "dev", buildRunId: 50, publicationAttempt: 2 });
  expect(selected.availability).toBe("available");
  expect(selected.source.publicationAttempt).toBe(2);
  expect(selected.archive?.sha256).toBe(HASH);
});

test("dispatch fixes the repository/workflow/ref and passes only exact explicit request selectors", async () => {
  const f = fixture();
  f.rows.set(`POST ${API}/actions/workflows/request-e2e-routine.yml/dispatches`, {
    workflow_run_id: 70, html_url: `https://github.com/${REPO}/actions/runs/70`, run_url: `${API}/actions/runs/70`,
  });
  expect((await f.gateway.dispatch(input)).requestRunId).toBe(70);
  const call = f.calls.at(-1)!;
  expect(JSON.parse(String(call.init?.body))).toEqual({ ref: "dev", return_run_details: true, inputs: {
    routine: "no-glasses", request_origin: "workflow-dispatch", source_build_run_id: "50", source_publication_attempt: "1", pr: "12",
  } });
});

test("request artifact reads are bounded and reject other files before decompression", async () => {
  await expect(readTestMetadata(new Response("12345"), 4)).rejects.toThrow("size limit");
  expect(readRequestZip(zipSync({ "request.json": strToU8('{"ok":true}') }))).toEqual({ ok: true });
  expect(() => readRequestZip(zipSync({ "request.json": strToU8("{}"), "run.sh": strToU8("bad") }))).toThrow("Unexpected");
  expect(() => readRequestZip(zipSync({ "request.json": new Uint8Array(1024 * 1024 + 1) }))).toThrow("Unexpected");
});

for (const channel of ["pr", "dev", "staging"] as const) for (const routineId of ["no-glasses", "no-glasses-android"] as const)
  test(`${channel} ${routineId} ready and no-artifact requests authenticate the exact source and artifact digest`, async () => {
  const selected: TestDispatchInput = { ...input, routineId, source: channel === "pr" ? input.source : { channel, buildRunId: 50, publicationAttempt: 1 } };
  for (const status of ["ready", "no-artifact"] as const) {
    const f = fixture();
    f.rows.set(`${API}/actions/runs/70/attempts/1`, run({ id: 70, event: "workflow_dispatch", head_branch: "dev", path: ".github/workflows/request-e2e-routine.yml" }));
    const request = { schemaVersion: channel === "pr" ? 1 : 2,
      ...(channel === "pr" ? {} : { source: { ...selected.source, kind: "coordinated-release" } }),
      kind: "mentra-routine-request", requestId: `routine-70-1-${channel === "pr" ? 12 : channel}-${routineId}`, status, reason: "No artifact for this revision", routine: { id: routineId, authorization: "workflow-dispatch" },
      trigger: { repository: REPO, kind: "workflow_dispatch", runId: 70, runAttempt: 1, sha: HEAD, workflowSha: HEAD, ref: "refs/heads/dev", workflow: ".github/workflows/request-e2e-routine.yml" },
      selection: status === "ready" ? { platform: testRoutinePlatform(routineId), archive: f.receipt.artifacts.mac, producer: { runId: 50, publicationAttempt: 1 } } : null };
    const bytes = zipSync({ "request.json": strToU8(JSON.stringify(request)) });
    f.rows.set(`${API}/actions/runs/70/artifacts?per_page=100`, { artifacts: [{ id: 80, name: "mentra-routine-request-70-1", expired: false,
      size_in_bytes: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, workflow_run: { id: 70, head_sha: HEAD } }] });
    f.rows.set(`${API}/actions/artifacts/80/zip`, new Response(null, { status: 302, headers: { location: "https://test.blob.core.windows.net/request.zip?signature=synthetic" } }));
    f.rows.set("https://test.blob.core.windows.net/request.zip?signature=synthetic", new Response(bytes));
    const progress = await f.gateway.progress(70, selected);
    expect(progress.state).toBe(status === "ready" ? "requesting" : "unavailable");
    const download = f.calls.find(call => call.url.includes("blob.core.windows.net"));
    expect(download?.init?.headers).toBeUndefined();
    if (status === "ready") {
      const calls: { url: string; authorization: string | null }[] = [];
      const fetch = (async (url: string, init?: RequestInit) => {
        calls.push({ url, authorization: new Headers(init?.headers).get("Authorization") });
        if (url === "https://api.github.com/app/installations/67890/access_tokens") {
          const scope = JSON.parse(String(init?.body)).repositories[0];
          return Response.json({ token: `token-${scope}`, expires_at: new Date(Date.now() + 3600_000).toISOString() }, { status: 201 });
        }
        return f.fetch(url, init);
      }) as typeof globalThis.fetch;
      f.rows.set("https://api.github.com/repos/Mentra-Community/Mentra-Automated-Testing/actions/workflows/device-routine.yml/runs?event=workflow_dispatch&branch=main&per_page=100", { workflow_runs: [] });
      const gateway = new GithubTestBuildGateway({ fetch, appAuth: new TestRunGithubApp({ credentials: appCredentials, fetch }) });
      expect((await gateway.progress(70, selected)).state).toBe("requesting");
      expect(calls.filter(call => call.url.startsWith(`${API}/`)).every(call => call.authorization === "Bearer token-MentraOS")).toBe(true);
      expect(calls.find(call => call.url.includes("/repos/Mentra-Community/Mentra-Automated-Testing/"))?.authorization).toBe("Bearer token-Mentra-Automated-Testing");
      expect(calls.find(call => call.url.includes("blob.core.windows.net"))?.authorization).toBeNull();
      request.selection!.platform = routineId === "no-glasses-android" ? "ios-on-mac" : "android";
      const changed = zipSync({ "request.json": strToU8(JSON.stringify(request)) });
      f.rows.set(`${API}/actions/runs/70/artifacts?per_page=100`, { artifacts: [{ id: 80, name: "mentra-routine-request-70-1", expired: false,
        size_in_bytes: changed.length, digest: `sha256:${createHash("sha256").update(changed).digest("hex")}`, workflow_run: { id: 70, head_sha: HEAD } }] });
      f.rows.set("https://test.blob.core.windows.net/request.zip?signature=synthetic", new Response(changed));
      await expect(f.gateway.progress(70, selected)).rejects.toThrow("different app publication");
    }
    if (channel !== "pr") {
      for (const source of [{ ...selected.source, channel: channel === "dev" ? "staging" as const : "dev" as const },
        { ...selected.source, buildRunId: 51 }, { ...selected.source, publicationAttempt: 2 }])
        await expect(f.gateway.progress(70, { ...selected, source })).rejects.toThrow("Published request source differs");
      await expect(f.gateway.progress(70, input)).rejects.toThrow("Published request source differs");
    } else {
      await expect(f.gateway.progress(70, { ...input, source: { channel: "dev", buildRunId: 50, publicationAttempt: 1 } }))
        .rejects.toThrow("Published request source differs");
    }
  }
});


function androidPrFixture() {
  const f = fixture(), name = `mentra-android-pr-12-${HEAD}-50-1`;
  const androidRun = run({ path: ".github/workflows/mentra-app-android-build.yml" });
  const publicationJobs = [{ ...jobs[0]!, steps: [{ name: "Upload APK to the public artifact CDN", status: "completed", conclusion: "success" }] }];
  const receipt = { schemaVersion: 1, pr: 12, headSha: HEAD, baseSha: BASE, buildSha: MERGE, runId: 50, runAttempt: 1,
    app: { packageId: "com.mentra.mentra", version: "3.3.0", build: "303000325", backend: "dev", headSha: HEAD, buildSha: MERGE,
      otaManifestUrl: `${CDN}pr-builds/ota-pr-12-${HEAD}.json` },
    artifacts: { android: { name: `${name}.apk`, sha256: HASH, size: 100 } } };
  f.rows.set(`${API}/actions/runs/50/attempts/1`, androidRun);
  f.rows.set(`${API}/actions/workflows/mentra-app-android-build.yml/runs?event=pull_request&head_sha=${HEAD}&per_page=10`, { workflow_runs: [androidRun] });
  f.rows.set(`${API}/actions/runs/50/jobs?filter=all&per_page=100&page=1`, { total_count: publicationJobs.length, jobs: publicationJobs });
  f.rows.set(`${CDN}pr-builds/${name}.json`, receipt);
  f.rows.set(`HEAD ${CDN}pr-builds/${name}.apk`, new Response(null, { headers: { "Content-Length": "100" } }));
  return { ...f, androidRun, receipt, publicationJobs, gateway: new GithubTestBuildGateway({ token: "test-only-token", fetch: f.fetch,
    routines: ["no-glasses", "no-glasses-android", "day1-ota", "mentra-call"] }) };
}

test("Android PR inventory validates its own signed APK receipt without needing an Apple build", async () => {
  const f = androidPrFixture();
  for (const build of [await f.gateway.resolve(input.source, "no-glasses-android"),
    ...(await f.gateway.inventory({ channel: "pr", pr: 12, routineId: "no-glasses-android" }))]) {
    expect(build.platform).toBe("android");
    expect(build.availability).toBe("available");
    expect(build.archive).toEqual(f.receipt.artifacts.android);
    expect(build.routines.filter(routine => routine.available).map(routine => routine.id)).toEqual(["no-glasses-android"]);
  }
  expect(f.calls.some(call => call.url.includes("mentra-ios") || call.url.includes("apple-downloads"))).toBe(false);
  await expect(f.gateway.resolve(input.source, "no-glasses")).rejects.toThrow("selected source");
});

test("registered connected-glasses is listed on an Android APK only, available only once a deployment enables it", async () => {
  expect(testRoutinePlatform("connected-glasses")).toBe("android");
  expect(TEST_ROUTINES.find(routine => routine.id === "connected-glasses")).not.toHaveProperty("planned");
  expect(testDispatchInputSchema.parse({ ...input, routineId: "connected-glasses" }).routineId).toBe("connected-glasses");
  const f = androidPrFixture();
  // Source registration is not deployment enablement: the default workers keep the ordinary enablement reason.
  const defaults = (await f.gateway.inventory({ channel: "pr", pr: 12, routineId: "connected-glasses" }))[0]!;
  expect(defaults.platform).toBe("android");
  expect(defaults.archive).toEqual(f.receipt.artifacts.android);
  expect(defaults.routines.find(routine => routine.id === "connected-glasses")).toEqual({ id: "connected-glasses", available: false,
    reason: "This routine is not enabled on the test workers yet" });
  const enrolled = new GithubTestBuildGateway({ token: "test-only-token", fetch: f.fetch, routines: ["no-glasses-android", "connected-glasses"] });
  const build = (await enrolled.inventory({ channel: "pr", pr: 12, routineId: "connected-glasses" }))[0]!;
  expect(build.routines.filter(routine => routine.available).map(routine => routine.id)).toEqual(["no-glasses-android", "connected-glasses"]);
  // Enabled Mac routines (account-miniapps, livestreamer) stay unavailable on the same APK.
  const planned = new GithubTestBuildGateway({ token: "test-only-token", fetch: f.fetch, routines: ["connected-glasses", "account-miniapps", "livestreamer"] });
  const rows = (await planned.inventory({ channel: "pr", pr: 12, routineId: "connected-glasses" }))[0]!.routines;
  expect(rows.filter(routine => routine.available).map(routine => routine.id)).toEqual(["connected-glasses"]);
});

test("Android PR rejects stale revisions, unsafe metadata, missing publication and wrong APK bytes", async () => {
  for (const scenario of ["base", "merge", "package", "receipt-run", "build-sha", "manifest", "name", "size", "publish", "later-failure"]) {
    const f = androidPrFixture();
    if (scenario === "base") f.receipt.baseSha = HEAD;
    if (scenario === "merge") f.rows.set(`${API}/commits/${MERGE}`, { sha: MERGE, parents: [{ sha: HEAD }, { sha: HEAD }] });
    if (scenario === "package") f.receipt.app.packageId = "other.app";
    if (scenario === "receipt-run") f.receipt.runId = 51;
    if (scenario === "build-sha") f.receipt.app.buildSha = HEAD;
    if (scenario === "manifest") f.rows.set(`${CDN}pr-builds/ota-pr-12-${HEAD}.json`, { releaseVersion: "another" });
    if (scenario === "name") f.receipt.artifacts.android.name = "other.apk";
    if (scenario === "size") f.receipt.artifacts.android.size = 101;
    if (scenario === "publish") f.publicationJobs[0]!.steps[0]!.conclusion = "skipped";
    if (scenario === "later-failure") {
      f.androidRun.run_attempt = 2;
      f.rows.set(`${API}/actions/runs/50/attempts/2`, f.androidRun);
      f.publicationJobs.push({ ...f.publicationJobs[0]!, id: 99, run_attempt: 2, conclusion: "failure" });
      f.rows.set(`${API}/actions/runs/50/jobs?filter=all&per_page=100&page=1`, { total_count: f.publicationJobs.length, jobs: f.publicationJobs });
    }
    // Inventory retains a useful unavailable row even for malformed metadata.
    const build = (await f.gateway.inventory({ channel: "pr", pr: 12, routineId: "no-glasses-android" }))[0]!;
    expect(build.availability).toBe("unavailable");
    expect(build.routines.every(routine => !routine.available)).toBe(true);
  }
});

test("Android notification-only retries retain the original successful APK publication attempt", async () => {
  const f = androidPrFixture();
  f.androidRun.run_attempt = 2; f.androidRun.conclusion = "failure";
  f.rows.set(`${API}/actions/runs/50/attempts/2`, f.androidRun);
  f.publicationJobs.push({ ...structuredClone(f.publicationJobs[0]!), id: 99, run_attempt: 2 });
  f.rows.set(`${API}/actions/runs/50/jobs?filter=all&per_page=100&page=1`, { total_count: f.publicationJobs.length, jobs: f.publicationJobs });
  const build = (await f.gateway.inventory({ channel: "pr", pr: 12, routineId: "no-glasses-android" }))[0]!;
  expect(build.availability).toBe("available");
  expect(build.source.publicationAttempt).toBe(1);
  await expect(f.gateway.resolve({ ...input.source, publicationAttempt: 2 }, "no-glasses-android")).rejects.toThrow("retained a different publication");
});

function androidReleaseFixture(channel: "dev" | "staging") {
  const f = releaseFixture(channel), tag = "mentra-builds-v3.3.0";
  const plan = f.rows.get(`${CDN}${tag}/mentra-release-plan-${f.identity}.json`) as Record<string, any>;
  plan.artifactNames.androidApp = `mentraos-${f.identity}-android.apk`;
  plan.artifactNames.releaseManifest = `mentra-release-${f.identity}.json`;
  const asset = { coordinate: plan.artifactNames.androidApp, url: `${CDN}${tag}/${plan.artifactNames.androidApp}`,
    sha256: HASH, size: 100, status: "built" };
  const receipt = { schemaVersion: 1, releaseSetId: `mentra-${f.identity}`, releaseIdentity: f.identity,
    sourceCommit: HEAD, channel: channel === "dev" ? "dev" : "beta", native: structuredClone(plan.native),
    releasePlanSha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex"), artifacts: [asset] };
  f.rows.set(`${CDN}${tag}/${plan.artifactNames.releaseManifest}`, receipt);
  f.rows.set(`HEAD ${asset.url}`, new Response(null, { headers: { "Content-Length": "100" } }));
  return { ...f, receipt, asset, plan, gateway: new GithubTestBuildGateway({ token: "test-only-token", fetch: f.fetch,
    channels: [channel], routines: ["no-glasses", "no-glasses-android", "day1-ota", "mentra-call"] }) };
}

for (const channel of ["dev", "staging"] as const) test(`${channel} Android uses the published release manifest APK and preserves exact source pins`, async () => {
  const f = androidReleaseFixture(channel);
  const source = { channel, buildRunId: 50, publicationAttempt: 1 };
  for (const build of [await f.gateway.resolve(source, "no-glasses-android"),
    ...(await f.gateway.inventory({ channel, routineId: "no-glasses-android" }))]) {
    expect(build.availability).toBe("available"); expect(build.platform).toBe("android");
    expect(build.source).toEqual(source); expect(build.release).toBe(f.identity);
    expect(build.archive?.name).toBe(f.asset.coordinate);
    expect(build.routines.filter(routine => routine.available).map(routine => routine.id)).toEqual(["no-glasses-android"]);
  }
  expect(f.calls.some(call => call.url.includes("apple-downloads") || call.url.endsWith("-mac.zip"))).toBe(false);
  for (const scenario of ["channel", "native", "plan-pin", "duplicate", "url", "status", "size", "publication"]) {
    const invalid = androidReleaseFixture(channel);
    if (scenario === "channel") invalid.receipt.channel = "prod";
    if (scenario === "native") invalid.receipt.native.buildNumber++;
    if (scenario === "plan-pin") invalid.receipt.releasePlanSha256 = HASH;
    if (scenario === "duplicate") invalid.receipt.artifacts.push({ ...invalid.asset });
    if (scenario === "url") invalid.asset.url = "https://elsewhere.example/other.apk";
    if (scenario === "status") invalid.asset.status = "failed";
    if (scenario === "size") invalid.asset.size = 101;
    if (scenario === "publication") invalid.publicationJobs[0]!.steps[0]!.conclusion = "skipped";
    const build = (await invalid.gateway.inventory({ channel, routineId: "no-glasses-android" }))[0]!;
    expect(build.availability).toBe("unavailable");
  }
});

test("Android release inventory admits only a Play-valid version code recorded above the family number", async () => {
  const source = { channel: "staging" as const, buildRunId: 50, publicationAttempt: 1 };
  // A family number below Play's beta floor, as finalization records it; every change re-pins the plan.
  const floored = (change: (f: ReturnType<typeof androidReleaseFixture>) => void) => {
    const f = androidReleaseFixture("staging");
    f.plan.native = { ...f.plan.native, playTrack: "beta", testflight: { audience: "external", group: "Mentra Staging Public" } };
    f.receipt.native = { ...structuredClone(f.plan.native), androidBuildNumber: 310000224 };
    change(f);
    f.receipt.releasePlanSha256 = createHash("sha256").update(JSON.stringify(f.plan)).digest("hex");
    return f;
  };
  for (const code of [undefined, 303000325, 310000224, 2_100_000_000]) {
    const f = floored(f => { f.receipt.native.androidBuildNumber = code; });
    for (const build of [await f.gateway.resolve(source, "no-glasses-android"),
      ...(await f.gateway.inventory({ channel: "staging", routineId: "no-glasses-android" }))]) {
      expect(build.availability).toBe("available");
      expect(build.archive?.name).toBe(f.asset.coordinate);
    }
  }
  const invalid: ((f: ReturnType<typeof androidReleaseFixture>) => void)[] = [
    ...[null, "310000224", 310000224.5, 303000324, 0, -1, 2_100_000_001, true, [310000224]]
      .map(code => (f: ReturnType<typeof androidReleaseFixture>) => { f.receipt.native.androidBuildNumber = code; }),
    f => { f.receipt.native.marketingVersion = "3.3.1"; }, f => { f.receipt.native.buildNumber = 310000224; },
    f => { f.receipt.native.playTrack = "internal"; }, f => { delete f.receipt.native.testflight; },
    f => { f.receipt.native.iosBuildNumber = 310000224; }, f => { f.plan.native.androidBuildNumber = 310000224; },
    f => { f.plan.native.buildNumber = f.receipt.native.buildNumber = 2_100_000_001; delete f.receipt.native.androidBuildNumber; },
  ];
  for (const change of invalid) {
    const f = floored(change);
    for (const build of [await f.gateway.resolve(source, "no-glasses-android"),
      ...(await f.gateway.inventory({ channel: "staging", routineId: "no-glasses-android" }))]) {
      expect(build.availability).toBe("unavailable");
      expect(build.reason).toBe("Android receipt does not match the selected coordinated release");
    }
  }
});

test("request adoption refuses truncated/ambiguous history and ignores a known pre-publication failure", async () => {
  const f = fixture(), since = "2026-09-25T08:00:00Z";
  const path = `${API}/actions/workflows/request-e2e-routine.yml/runs?event=workflow_dispatch&branch=dev&created=${encodeURIComponent(">=" + since)}&per_page=100`;
  f.rows.set(path, { total_count: 101, workflow_runs: [] });
  await expect(f.gateway.findExisting(input, since)).rejects.toThrow("incomplete");
  const failed = run({ id: 70, head_branch: "dev", path: ".github/workflows/request-e2e-routine.yml", event: "workflow_dispatch", conclusion: "failure" });
  f.rows.set(path, { total_count: 1, workflow_runs: [failed] });
  f.rows.set(`${API}/actions/runs/70/attempts/1`, failed);
  f.rows.set(`${API}/actions/runs/70/artifacts?per_page=100`, { artifacts: [] });
  expect(await f.gateway.findExisting(input, since)).toBeNull();
  f.rows.set(path, { total_count: 1, workflow_runs: [{ ...failed, status: "in_progress" }] });
  await expect(f.gateway.findExisting(input, since)).rejects.toThrow("unresolved");
});

test("failed or cancelled request producers cannot be adopted even if they retained an artifact", async () => {
  for (const conclusion of ["failure", "cancelled"]) {
    const f = fixture(), since = "2026-09-25T08:00:00Z";
    const path = `${API}/actions/workflows/request-e2e-routine.yml/runs?event=workflow_dispatch&branch=dev&created=${encodeURIComponent(">=" + since)}&per_page=100`;
    f.rows.set(path, { total_count: 1, workflow_runs: [run({ id: 70, head_branch: "dev", path: ".github/workflows/request-e2e-routine.yml", event: "workflow_dispatch", conclusion })] });
    expect(await f.gateway.findExisting(input, since)).toBeNull();
    expect(f.calls).toHaveLength(1);
  }
});

test("a replay request's progress is bound to its original request marker, and an ordinary request never matches a replay", async () => {
  const replayInput: TestDispatchInput = { ...input, originalRequestRunId: 60 };
  for (const [marker, selected, ok] of [[{ requestId: "routine-60-1-12-no-glasses", runId: 60, runAttempt: 1, artifactDigest: HASH }, replayInput, true],
    [{ requestId: "routine-61-1-12-no-glasses", runId: 61, runAttempt: 1, artifactDigest: HASH }, replayInput, false],
    [undefined, replayInput, false], [{ requestId: "routine-60-1-12-no-glasses", runId: 60, runAttempt: 1, artifactDigest: HASH }, input, false],
    [undefined, input, true]] as const) {
    const f = fixture();
    f.rows.set(`${API}/actions/runs/70/attempts/1`, run({ id: 70, event: "workflow_dispatch", head_branch: "dev", path: ".github/workflows/request-e2e-routine.yml" }));
    const request = { schemaVersion: 1, kind: "mentra-routine-request", requestId: "routine-70-1-12-no-glasses", status: "ready", reason: "Replay",
      routine: { id: "no-glasses", authorization: "workflow-dispatch" },
      trigger: { repository: REPO, kind: "workflow_dispatch", runId: 70, runAttempt: 1, sha: HEAD, workflowSha: HEAD, ref: "refs/heads/dev", workflow: ".github/workflows/request-e2e-routine.yml" },
      pullRequest: { number: 12, headSha: HEAD, baseSha: BASE, baseRef: "dev" }, ...(marker ? { original: marker } : {}),
      selection: { platform: "ios-on-mac", archive: f.receipt.artifacts.mac, producer: { runId: 50, publicationAttempt: 1 } } };
    const bytes = zipSync({ "request.json": strToU8(JSON.stringify(request)) });
    f.rows.set(`${API}/actions/runs/70/artifacts?per_page=100`, { artifacts: [{ id: 80, name: "mentra-routine-request-70-1", expired: false,
      size_in_bytes: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, workflow_run: { id: 70, head_sha: HEAD } }] });
    f.rows.set(`${API}/actions/artifacts/80/zip`, new Response(null, { status: 302, headers: { location: "https://test.blob.core.windows.net/request.zip?signature=synthetic" } }));
    f.rows.set("https://test.blob.core.windows.net/request.zip?signature=synthetic", new Response(bytes));
    if (ok) expect((await f.gateway.progress(70, selected)).state).toBe("requesting");
    else await expect(f.gateway.progress(70, selected)).rejects.toThrow("Published request identity differs");
  }
});

test("dispatch sends an original replay by its request run only, and refuses a non-PR replay", async () => {
  const f = fixture(), bodies: unknown[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") { bodies.push(JSON.parse(String(init.body)));
      return Response.json({ workflow_run_id: 90, html_url: `https://github.com/${REPO}/actions/runs/90`, run_url: `${API}/actions/runs/90` }); }
    return f.fetch(url, init);
  }) as typeof globalThis.fetch;
  const gateway = new GithubTestBuildGateway({ token: "test-only-token", fetch });
  await gateway.dispatch({ ...input, originalRequestRunId: 60 });
  await gateway.dispatch(input);
  expect(bodies).toEqual([
    { ref: "dev", return_run_details: true, inputs: { routine: "no-glasses", request_origin: "workflow-dispatch", original_request_run_id: "60", pr: "12" } },
    { ref: "dev", return_run_details: true, inputs: { routine: "no-glasses", request_origin: "workflow-dispatch", source_build_run_id: "50",
      source_publication_attempt: "1", pr: "12" } }]);
  await expect(gateway.dispatch({ ...input, source: { channel: "dev", buildRunId: 50, publicationAttempt: 1 }, originalRequestRunId: 60 }))
    .rejects.toThrow("Only a PR original");
  // Admin input cannot carry an original replay.
  expect(testDispatchInputSchema.safeParse({ ...input, originalRequestRunId: 60 }).success).toBe(false);
});


test("only the trusted continuation argument adds a restrictive private harness pin", async () => {
  const f = fixture(), pin = "f".repeat(40);
  f.rows.set(`POST ${API}/actions/workflows/request-e2e-routine.yml/dispatches`, {
    workflow_run_id: 70, html_url: `https://github.com/${REPO}/actions/runs/70`, run_url: `${API}/actions/runs/70`,
  });
  await f.gateway.dispatch(input, pin);
  expect(JSON.parse(String(f.calls.at(-1)!.init?.body)).inputs).toEqual({
    routine: "no-glasses", request_origin: "workflow-dispatch", source_build_run_id: "50", source_publication_attempt: "1", pr: "12",
    expected_harness_sha: pin,
  });
  const calls = f.calls.length;
  await expect(f.gateway.dispatch(input, "main")).rejects.toThrow();
  expect(f.calls.length).toBe(calls);
});
