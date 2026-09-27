import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import type { ContinuationGrant } from "../types/test-continuation.types";
import type { TestDispatchReceipt } from "../types/test-dispatch.types";
import { createTestFailureAgentApi } from "../api/agent/test-failures.api";
import { GithubTestBuildGateway } from "./test-builds.service";
import { signTestContinuationGrant } from "./test-failure-auth";
import { GithubContinuationSource } from "./test-continuation.github";
import { TestContinuationService, continuationOperationId } from "./test-continuation.service";
import { TestDispatchService, type TestDispatchRepository } from "./test-dispatch.service";
import type { TestRunGithubApp } from "./test-run-github-app";
import type { TestRunService } from "./test-run.service";

// The real build gateway, dispatcher and source resolver over synthetic GitHub/CDN responses.
const REPO = "Mentra-Community/MentraOS", API = `https://api.github.com/repos/${REPO}`;
const CDN = `https://artifactscdn.mentraglass.com/${REPO}/releases/`;
const HEAD = "a".repeat(40), BASE = "b".repeat(40), MERGE = "c".repeat(40), HASH = "d".repeat(64), MOVED = "e".repeat(40);
const occurrenceId = "tfo_" + "a".repeat(64), DISPATCH = `POST ${API}/actions/workflows/request-e2e-routine.yml/dispatches`;
const grant: ContinuationGrant = { purpose: "mentra-routine-fixer-continuation-v1", environment: "dev", occurrenceId, agentRunId: "run_123",
  candidate: { repository: REPO, headSha: HEAD, target: "original" }, executionAttempt: 1, leaseGeneration: 1, leaseTokenSha256: "e".repeat(64),
  routineIds: ["no-glasses"], actions: ["request-routine", "read-results"], expires: Math.floor(Date.now() / 1000) + 600 };
const buildRun = (extra = {}) => ({ id: 50, run_attempt: 1, head_sha: HEAD, head_branch: "candidate", path: ".github/workflows/mentra-app-ios-build.yml",
  event: "pull_request", status: "completed", conclusion: "success", created_at: "2026-09-23T01:00:00Z", display_title: "Candidate",
  repository: { full_name: REPO }, head_repository: { full_name: REPO }, ...extra });
const jobs = ["build", "publish"].map((name, index) => ({ id: index + 1, name, run_attempt: 1, status: "completed", conclusion: "success",
  started_at: "2026-09-23T01:00:00Z", completed_at: "2026-09-23T01:10:00Z" }));

function fixture(channel: "pr" | "dev" | "staging" = "pr") {
  const rows = new Map<string, unknown>(), calls: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`; calls.push(key);
    if (key === DISPATCH) bodies.push(JSON.parse(String(init?.body)));
    const value = rows.get(key) ?? rows.get(url);
    if (value instanceof Response) return value.clone();
    return value === undefined ? new Response("missing", { status: 404 }) : Response.json(value);
  }) as typeof globalThis.fetch;
  const receipt = { schemaVersion: 2, pr: 12, headSha: HEAD, runId: 50, runAttempt: 1, buildSha: MERGE,
    app: { bundleId: "com.mentra.mentra", teamId: "T5XXXL6N36", backend: "dev", headSha: HEAD, buildSha: MERGE, runId: 50, runAttempt: 1,
      executableSha256: HASH, javascriptSha256: HASH, otaManifestUrl: `${CDN}pr-builds/ota-pr-12-${HEAD}.json` },
    artifacts: { mac: { name: `mentra-ios-mac-pr-12-${HEAD}-50-1.zip`, sha256: HASH, size: 100 } } };
  const pr = { number: 12, state: "open", title: "Candidate", head: { sha: HEAD, ref: "candidate", repo: { full_name: REPO } }, base: { ref: "dev" } };
  rows.set(`${API}/pulls/12`, pr);
  rows.set(`${API}/git/ref/heads/dev`, { ref: "refs/heads/dev", object: { type: "commit", sha: BASE } });
  if (channel === "pr") {
    rows.set(`${API}/actions/runs/50/attempts/1`, buildRun());
    rows.set(`${API}/actions/runs/50/jobs?filter=all&per_page=100&page=1`, { total_count: jobs.length, jobs });
    rows.set(`${CDN}pr-builds/mentra-ios-pr-12-${HEAD}-50-1.json`, receipt);
    rows.set(`${CDN}pr-builds/ota-pr-12-${HEAD}.json`, { releaseVersion: `pr-12-${HEAD}` });
    rows.set(`${API}/commits/${MERGE}`, { sha: MERGE, parents: [{ sha: BASE }, { sha: HEAD }] });
    rows.set(`HEAD ${CDN}pr-builds/${receipt.artifacts.mac.name}`, new Response(null, { headers: { "Content-Length": "100" } }));
  } else {
    // A retained coordinated build, older than the newest listed release run.
    const release = channel === "dev" ? "dev" : "beta", identity = `3.3.0-${release}.325`, tag = "mentra-builds-v3.3.0";
    const run = buildRun({ event: "push", head_branch: channel, path: ".github/workflows/coordinated-release.yml" });
    rows.set(`${API}/actions/runs/50/attempts/1`, run);
    rows.set(`${API}/actions/workflows/coordinated-release.yml/runs?branch=${channel}&per_page=10`, { workflow_runs: [{ ...run, id: 60, head_sha: MOVED }] });
    rows.set(`${API}/actions/runs/50/jobs?filter=all&per_page=100&page=1`, { total_count: 1, jobs: [{ ...jobs[0]!, name: "Finalize immutable release bill of materials",
      steps: [{ name: "Publish immutable plan, package, and manifest assets", status: "completed", conclusion: "success" }] }] });
    rows.set(`${API}/actions/runs/50/artifacts?per_page=100`, { artifacts: [{ name: `coordinated-release-plan-mentra-${identity}`, expired: false,
      workflow_run: { id: 50, head_sha: HEAD } }] });
    rows.set(`${CDN}${tag}/mentra-release-plan-${identity}.json`, { releaseIdentity: identity, sourceCommit: HEAD, channel: release,
      artifactContainerTag: tag, native: { buildNumber: 303000325, marketingVersion: "3.3.0" }, artifactNames: { otaManifest: `mentra-live-ota-${identity}.json` } });
    rows.set(`${CDN}${tag}/mentraos-${identity}-apple-downloads.json`, { schemaVersion: 1, releaseIdentity: identity, sourceCommit: HEAD,
      app: { bundleId: "com.mentra.mentra", headSha: HEAD, backend: channel, build: "303000325", version: "3.3.0",
        otaManifestUrl: `${CDN}${tag}/mentra-live-ota-${identity}.json`, executableSha256: HASH, javascriptSha256: HASH },
      artifacts: { mac: { name: `mentraos-${identity}-mac.zip`, size: 100, sha256: HASH } } });
    rows.set(`${CDN}${tag}/mentra-live-ota-${identity}.json`, { releaseVersion: identity });
    rows.set(`HEAD ${CDN}${tag}/mentraos-${identity}-mac.zip`, new Response(null, { headers: { "Content-Length": "100" } }));
  }
  // The trusted issuer's immutable request 70 that selected the original build.
  const source = channel === "pr" ? { channel: "pr" as const, prNumber: 12, buildRunId: 50, publicationAttempt: 1 } : { channel, buildRunId: 50, publicationAttempt: 1 };
  const originalRequest = { schemaVersion: channel === "pr" ? 1 : 2, kind: "mentra-routine-request",
    ...(channel === "pr" ? { pullRequest: { number: 12, url: `https://github.com/${REPO}/pull/12`, headSha: HEAD, baseSha: BASE,
      headRepository: REPO, baseRef: "dev" } } : { source: { kind: "coordinated-release", channel, buildRunId: 50, publicationAttempt: 1 } }),
    requestId: `routine-70-1-${channel === "pr" ? 12 : channel}-no-glasses`, status: "ready", reason: "Verified", routine: { id: "no-glasses", authorization: "workflow-dispatch" },
    trigger: { repository: REPO, kind: "workflow_dispatch", runId: 70, runAttempt: 1, sha: HEAD, workflowSha: HEAD, ref: "refs/heads/dev", workflow: ".github/workflows/request-e2e-routine.yml" },
    selection: { platform: "ios-on-mac", archive: { name: "app.zip", sha256: HASH, size: 100 }, producer: { runId: 50, publicationAttempt: 1 },
      build: channel === "pr" ? { headSha: HEAD, baseSha: BASE, buildSha: MERGE } : { sourceCommit: HEAD } } };
  const publish = (value: unknown) => {
    const bytes = zipSync({ "request.json": strToU8(JSON.stringify(value)) });
    rows.set(`${API}/actions/runs/70/attempts/1`, buildRun({ id: 70, event: "workflow_dispatch", head_branch: "dev", path: ".github/workflows/request-e2e-routine.yml" }));
    rows.set(`${API}/actions/runs/70/artifacts?per_page=100`, { artifacts: [{ id: 80, name: "mentra-routine-request-70-1", expired: false,
      size_in_bytes: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, workflow_run: { id: 70, head_sha: HEAD } }] });
    rows.set(`${API}/actions/artifacts/80/zip`, new Response(null, { status: 302, headers: { location: "https://test.blob.core.windows.net/request.zip?signature=synthetic" } }));
    rows.set("https://test.blob.core.windows.net/request.zip?signature=synthetic", new Response(bytes));
  };
  publish(originalRequest);
  rows.set(DISPATCH, { workflow_run_id: 90, html_url: `https://github.com/${REPO}/actions/runs/90`, run_url: `${API}/actions/runs/90` });
  const packet = { schemaVersion: 1, occurrenceId, requestId: originalRequest.requestId, routine: { id: "no-glasses", version: "1" },
    source: channel === "pr" ? { schemaVersion: 1, trigger: "pr", repository: REPO, channel: "pr", headSha: HEAD, branch: "candidate",
      pullRequest: { number: 12, headRepository: REPO, baseBranch: "dev", baseSha: BASE } }
      : { schemaVersion: 1, trigger: "nightly", repository: REPO, channel, headSha: HEAD, branch: channel },
    sourceStatus: "recorded", build: { channel, prNumber: channel === "pr" ? 12 : null, hashes: { headSha: HEAD, archiveSha256: HASH } },
    delivery: { state: "acknowledged", agentRunId: "run_123" } } as unknown as Awaited<ReturnType<TestRunService["failureDetail"]>>;
  const receipts = new Map<string, { inputSha256: string; receipt: TestDispatchReceipt }>();
  const repository: TestDispatchRepository = {
    get: async id => receipts.get(id) ?? null, recent: async () => [],
    insert: async value => { const before = receipts.get(value.receipt.dispatchId); if (before) return { stored: before, created: false };
      receipts.set(value.receipt.dispatchId, value); return { stored: value, created: true }; },
    acknowledge: async (id, response) => { const value = receipts.get(id)!.receipt; Object.assign(value, { sendState: response ? "accepted" : "unknown", ...response }); return value; },
    claim: async () => null, result: async () => { throw new Error("no result"); },
  };
  const gateway = new GithubTestBuildGateway({ token: "test-only-token", fetch, channels: ["pr", "dev", "staging"] });
  // The original target never asks GitHub about the PR through the source resolver.
  const app = { token: async () => { throw new Error("original target must not look up a PR"); } } as unknown as TestRunGithubApp;
  const runs = { failureDetail: async () => packet } as unknown as TestRunService;
  const service = new TestContinuationService(runs, new TestDispatchService(repository, gateway), gateway,
    new GithubContinuationSource({ app, fetch }), { list: async () => [], results: async () => [], claim: async () => null }, async () => {});
  const input = { source, routineId: "no-glasses", archiveSha256: HASH };
  return { rows, calls, bodies, receipts, service, runs, input, pr, receipt, originalRequest, publish, packet,
    sends: () => calls.filter(call => call === DISPATCH).length };
}

test("an open unchanged PR original is selected and dispatched only by its recorded request's exact build", async () => {
  const f = fixture();
  const inventory = await f.service.inventory(grant, "no-glasses");
  expect(inventory.builds.map(build => [build.source, build.availability, build.archive?.sha256])).toEqual([[f.input.source, "available", HASH]]);
  const sent = await f.service.request(grant, f.input);
  expect(sent).toMatchObject({ dispatchId: continuationOperationId(grant, "no-glasses"), sendState: "accepted", requestRunId: 90 });
  expect(f.sends()).toBe(1);
  expect(f.receipts.get(sent.dispatchId)!.receipt).toMatchObject({ input: { source: f.input.source, archiveSha256: HASH },
    continuation: { candidate: grant.candidate, expectedHeadSha: HEAD } });
  // Never adopts the original (or any earlier) request as this attempt.
  expect(f.calls.some(call => call.includes("request-e2e-routine.yml/runs?"))).toBe(false);
});

test("after a PR push, base advance, close or merge the original is replayed exactly by its request, never by the current head", async () => {
  for (const change of ["none", "head", "base", "closed", "merged"]) {
    const f = fixture();
    if (change === "head") f.rows.set(`${API}/pulls/12`, { ...f.pr, head: { ...f.pr.head, sha: MOVED } });
    if (change === "base") f.rows.set(`${API}/git/ref/heads/dev`, { ref: "refs/heads/dev", object: { type: "commit", sha: MOVED } });
    if (change === "closed" || change === "merged") f.rows.set(`${API}/pulls/12`, { ...f.pr, state: "closed", ...(change === "merged" ? { merged: true } : {}) });
    const inventory = await f.service.inventory(grant, "no-glasses");
    expect(inventory.builds.map(build => [build.source, build.availability, build.archive?.sha256])).toEqual([[f.input.source, "available", HASH]]);
    const sent = await f.service.request(grant, f.input);
    expect(sent).toMatchObject({ dispatchId: continuationOperationId(grant, "no-glasses"), sendState: "accepted" });
    expect(f.sends()).toBe(1);
    // The trusted issuer is asked to replay the original request; no caller build metadata is sent.
    expect(f.bodies[0]).toEqual({ ref: "dev", return_run_details: true, inputs: { routine: "no-glasses", request_origin: "workflow-dispatch",
      original_request_run_id: "70", pr: "12" } });
    expect(f.receipts.get(sent.dispatchId)!.receipt.input).toMatchObject({ source: f.input.source, archiveSha256: HASH, originalRequestRunId: 70 });
    // Neither the current PR, its base nor its head builds were consulted; no earlier request is adopted.
    expect(f.calls.some(call => call.endsWith("/pulls/12") || call.includes("git/ref/heads/dev") || call.includes(`head_sha=${MOVED}`)
      || call.includes("request-e2e-routine.yml/runs?"))).toBe(false);
    // A replay acknowledgement is idempotent for the same packet-derived original request.
    await f.service.request(grant, f.input); expect(f.sends()).toBe(1);
  }
});

test("a caller-named run, publication, source or archive, or a changed receipt, request or backend is rejected", async () => {
  const cases: [string, (f: ReturnType<typeof fixture>) => Record<string, unknown>, string][] = [
    ["run", f => ({ ...f.input, source: { ...f.input.source, buildRunId: 51 } }), "original recorded artifact"],
    ["publication", f => ({ ...f.input, source: { ...f.input.source, publicationAttempt: 2 } }), "original recorded artifact"],
    ["source", f => ({ ...f.input, source: { channel: "dev", buildRunId: 50, publicationAttempt: 1 } }), "outside the candidate source"],
    ["archive", f => ({ ...f.input, archiveSha256: "f".repeat(64) }), "original recorded artifact"],
    ["request-archive", f => { f.publish({ ...f.originalRequest, selection: { ...f.originalRequest.selection, archive: { name: "x.zip", sha256: "f".repeat(64), size: 1 } } }); return f.input; }, "differs from the recorded result"],
    ["request-run", f => { f.publish({ ...f.originalRequest, selection: { ...f.originalRequest.selection, producer: { runId: 51, publicationAttempt: 1 } } }); return f.input; }, "original recorded artifact"],
    ["request-head", f => { f.publish({ ...f.originalRequest, selection: { ...f.originalRequest.selection, build: { headSha: MOVED } } }); return f.input; }, "differs"],
    ["request-routine", f => { f.publish({ ...f.originalRequest, routine: { id: "day1-ota", authorization: "workflow-dispatch" } }); return f.input; }, "did not select a published build"],
    ["request-missing", f => { f.rows.delete(`${API}/actions/runs/70/artifacts?per_page=100`); return f.input; }, "not found"],
    ["recorded-request", f => { (f.packet as { requestId: string }).requestId = "local-request"; return f.input; }, "original request identity was not recorded"],
    ["backend", f => { f.receipt.app.backend = "staging"; return f.input; }, "The original build can no longer be dispatched"],
    ["merge-source", f => { f.rows.set(`${API}/commits/${MERGE}`, { sha: MERGE, parents: [{ sha: MOVED }, { sha: HEAD }] }); return f.input; }, "The original build can no longer be dispatched"],
    ["producer-head", f => { f.rows.set(`${API}/actions/runs/50/attempts/1`, buildRun({ head_sha: MOVED })); return f.input; }, "The original build can no longer be dispatched"],
    ["request-pr", f => { f.publish({ ...f.originalRequest, pullRequest: { ...(f.originalRequest as { pullRequest: Record<string, unknown> }).pullRequest, baseSha: MOVED } }); return f.input; }, "PR identity differs"],
  ];
  for (const [name, change, message] of cases) {
    const f = fixture(), input = change(f);
    await expect(f.service.request(grant, input), name).rejects.toThrow(message);
    expect(f.sends()).toBe(0); expect(f.receipts.size).toBe(0);
  }
});

for (const channel of ["dev", "staging"] as const) test(`a retained older ${channel} original outside the newest listing is selected and dispatched exactly`, async () => {
  const f = fixture(channel);
  const inventory = await f.service.inventory(grant, "no-glasses");
  expect(inventory.builds.map(build => [build.source, build.availability])).toEqual([[f.input.source, "available"]]);
  expect(f.calls.some(call => call.includes("coordinated-release.yml/runs?"))).toBe(false);
  const sent = await f.service.request(grant, f.input);
  expect(sent.sendState).toBe("accepted"); expect(f.sends()).toBe(1);
  // The release backend must be this channel's; a local or other-channel source is not promoted.
  const g = fixture(channel);
  (g.packet.source as { channel: string; branch: string; trigger: string }) = { ...(g.packet.source as object), channel: "local", branch: "feature", trigger: "local" } as never;
  await expect(g.service.request(grant, g.input)).rejects.toMatchObject({ status: 501, message: expect.stringContaining("Unsupported replay") });
  await expect(g.service.inventory(grant, "no-glasses")).rejects.toMatchObject({ status: 501 });
  expect(g.sends()).toBe(0);
  // Untrusted provenance (another repository) remains a refusal, not a capability limit.
  const h = fixture(channel);
  (h.packet.source as { repository: string }).repository = "someone/else";
  await expect(h.service.request(grant, h.input)).rejects.toMatchObject({ status: 409 });
});

test("over HTTP a local original is a 501 unsupported_replay capability result, distinct from a 409 refusal", async () => {
  const secret = "original-replay-test-signing-".repeat(2), oldSecret = process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET, oldEnv = process.env.CLOUD_CORE_ENVIRONMENT;
  process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET = secret; process.env.CLOUD_CORE_ENVIRONMENT = "dev";
  try {
    const f = fixture("dev");
    (f.packet.source as { channel: string; branch: string; trigger: string }) = { ...(f.packet.source as object), channel: "local", branch: "dev", trigger: "local" } as never;
    const app = createTestFailureAgentApi(f.runs as never, f.service);
    const headers = { authorization: `Bearer ${signTestContinuationGrant(grant, secret)}` };
    const post = await app.request(`/${occurrenceId}/reruns`, { method: "POST", headers, body: JSON.stringify(f.input) });
    expect(post.status).toBe(501);
    expect(await post.json()).toMatchObject({ error: "unsupported_replay" });
    const builds = await app.request(`/${occurrenceId}/builds?routineId=no-glasses`, { headers });
    expect(builds.status).toBe(501);
    const g = fixture("dev");
    (g.packet.source as { repository: string }).repository = "someone/else";
    const refused = await createTestFailureAgentApi(g.runs as never, g.service).request(`/${occurrenceId}/reruns`, { method: "POST", headers, body: JSON.stringify(g.input) });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "test_continuation_error" });
    expect(f.sends() + g.sends()).toBe(0);
  } finally {
    if (oldSecret === undefined) delete process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET; else process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET = oldSecret;
    if (oldEnv === undefined) delete process.env.CLOUD_CORE_ENVIRONMENT; else process.env.CLOUD_CORE_ENVIRONMENT = oldEnv;
  }
});
