import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { GithubTestBuildGateway, readRequestZip, readTestMetadata } from "./test-builds.service";
import { testBuildQuerySchema, testDispatchInputSchema, type TestDispatchInput } from "../types/test-dispatch.types";

const REPO = "Mentra-Community/MentraOS";
const API = `https://api.github.com/repos/${REPO}`;
const CDN = `https://artifactscdn.mentraglass.com/${REPO}/releases/`;
const HEAD = "a".repeat(40), BASE = "b".repeat(40), MERGE = "c".repeat(40), HASH = "d".repeat(64);
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
});

describe("exact PR build inventory", () => {
  test("a current published build is selectable without a PR label", async () => {
    const f = fixture();
    const selected = await f.gateway.resolve(input.source);
    expect(selected.availability).toBe("available");
    expect(selected.archive?.sha256).toBe(HASH);
    expect(selected.routines.every(routine => routine.available)).toBe(true);
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
});

for (const channel of ["dev", "staging"] as const) test(`${channel} inventories coordinated Mac receipts without fabricating PR provenance`, async () => {
  const f = fixture(), releaseChannel = channel === "dev" ? "dev" : "beta", identity = `3.3.0-${releaseChannel}.325`, tag = "mentra-builds-v3.3.0";
  const releaseRun = run({ event: "push", head_branch: channel, path: ".github/workflows/coordinated-release.yml" });
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
  const builds = await f.gateway.inventory({ channel });
  expect(builds[0]?.availability).toBe("available");
  expect(builds[0]?.release).toBe(identity);
  expect(builds[0]?.source).toEqual({ channel, buildRunId: 50, publicationAttempt: 1 });
  expect(builds[0]?.routines[0]?.available).toBe(false);
  expect(builds[0]?.routines[0]?.reason).toContain("not enabled");
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

test("ready and no-artifact request status is authenticated against the source artifact digest", async () => {
  for (const status of ["ready", "no-artifact"] as const) {
    const f = fixture();
    f.rows.set(`${API}/actions/runs/70/attempts/1`, run({ id: 70, event: "workflow_dispatch", head_branch: "dev", path: ".github/workflows/request-e2e-routine.yml" }));
    const request = { schemaVersion: 1, kind: "mentra-routine-request", requestId: "routine-70-1-12-no-glasses", status, reason: "No artifact for this revision", routine: { id: "no-glasses", authorization: "workflow-dispatch" },
      trigger: { repository: REPO, kind: "workflow_dispatch", runId: 70, runAttempt: 1, sha: HEAD, workflowSha: HEAD, ref: "refs/heads/dev", workflow: ".github/workflows/request-e2e-routine.yml" },
      selection: status === "ready" ? { archive: f.receipt.artifacts.mac, producer: { runId: 50, publicationAttempt: 1 } } : null };
    const bytes = zipSync({ "request.json": strToU8(JSON.stringify(request)) });
    f.rows.set(`${API}/actions/runs/70/artifacts?per_page=100`, { artifacts: [{ id: 80, name: "mentra-routine-request-70-1", expired: false,
      size_in_bytes: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, workflow_run: { id: 70, head_sha: HEAD } }] });
    f.rows.set(`${API}/actions/artifacts/80/zip`, new Response(null, { status: 302, headers: { location: "https://test.blob.core.windows.net/request.zip?signature=synthetic" } }));
    f.rows.set("https://test.blob.core.windows.net/request.zip?signature=synthetic", new Response(bytes));
    const progress = await f.gateway.progress(70, input);
    expect(progress.state).toBe(status === "ready" ? "requesting" : "unavailable");
    const download = f.calls.find(call => call.url.includes("blob.core.windows.net"));
    expect(download?.init?.headers).toBeUndefined();
  }
});
