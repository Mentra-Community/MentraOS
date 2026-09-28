import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { ContinuationExecutionDestination, ContinuationGrant } from "../types/test-continuation.types";
import type { TestDispatchReceipt } from "../types/test-dispatch.types";
import { GithubContinuationSource, type FailurePacket } from "./test-continuation.github";
import { requireContinuationLease } from "./test-continuation-lease";
import { TestContinuationService, continuationOperationId } from "./test-continuation.service";
import { TestDispatchService, type TestDispatchRepository } from "./test-dispatch.service";
import { signTestContinuationGrant, verifyTestContinuationGrant } from "./test-failure-auth";
import type { TestBuildGateway } from "./test-builds.service";
import type { TestRunGithubApp } from "./test-run-github-app";
import type { TestRunService } from "./test-run.service";

// The preserved Notes case: a local build of the feature branch later merged as #4277 into dev. Its source is never changed.
const PUB = "Mentra-Community/MentraOS", feature = "codex/notes-pause-flush-bundle", anchor = "07b232ae-527b-4df0-88d8-483ee257ac06";
const tested = "1ddae0ef1ee199d4396e8c00540fb8b08bf9a6f4", merge = "0a30d0aaaf06f63e579e33458842aa3040e23ff5";
const candidateHead = "c".repeat(40), candidateMerge = "d".repeat(40), archiveSha256 = "e".repeat(64), occurrenceId = "tfo_" + "a".repeat(64);
const secret = "destination-test-only-secret-".repeat(2);
const merged = (): ContinuationExecutionDestination => ({ repository: PUB, baseBranch: "dev", sourceOrigin: { pullRequest: 4277, state: "merged", mergeCommitSha: merge } });
const open = (): ContinuationExecutionDestination => ({ repository: PUB, baseBranch: "dev", sourceOrigin: { pullRequest: 4277, state: "open" } });
const grantFor = (destination: ContinuationExecutionDestination | undefined, pullRequest = 4300): ContinuationGrant => ({
  purpose: "mentra-routine-fixer-continuation-v1", environment: "dev", occurrenceId, agentRunId: anchor,
  candidate: { repository: PUB, pullRequest, headSha: candidateHead }, ...(destination ? { executionDestination: destination } : {}),
  executionAttempt: 1, leaseGeneration: 2, leaseTokenSha256: "f".repeat(64), routineIds: ["notes-phone"], actions: ["request-routine", "read-results"],
  expires: Math.floor(Date.now() / 1000) + 600 });
type Pr = { number: number; state: string; merged: boolean; merge_commit_sha: string | null; merged_at: string | null;
  head: { sha: string; ref: string; repo: { full_name: string } | null }; base: { ref: string; repo: { full_name: string } }; labels: { name: string }[] };

/** The production gateway over a mocked provider: the tested commit's PR list, PR records and comparisons. */
function provider() {
  const origin: Pr = { number: 4277, state: "closed", merged: true, merge_commit_sha: merge, merged_at: "2026-09-28T06:27:48Z",
    head: { sha: tested, ref: feature, repo: { full_name: PUB } }, base: { ref: "dev", repo: { full_name: PUB } }, labels: [] };
  const fix: Pr = { number: 4300, state: "open", merged: false, merge_commit_sha: null, merged_at: null,
    head: { sha: candidateHead, ref: `codex/routine-${anchor}`, repo: { full_name: PUB } }, base: { ref: "dev", repo: { full_name: PUB } }, labels: [] };
  const state = { listed: [{ number: 4277, head: { ref: feature, repo: { full_name: PUB } } }] as unknown[], prs: new Map<number, Pr>([[4277, origin], [4300, fix]]),
    compare: new Map<string, string>([[`${tested}...dev`, "ahead"], [`${merge}...dev`, "ahead"], [`${tested}...${candidateHead}`, "ahead"]]), calls: [] as string[] };
  const gateway = new GithubContinuationSource({ app: { token: async () => "fixture" } as unknown as TestRunGithubApp,
    fetch: (async (url: string, init?: RequestInit) => {
      expect(init?.method).toBeUndefined(); const path = new URL(url).pathname.replace(`/repos/${PUB}/`, ""); state.calls.push(path + new URL(url).search);
      if (path === `commits/${tested}/pulls`) { expect(new URL(url).search).toBe("?per_page=100"); return Response.json(state.listed); }
      const pr = /^pulls\/(\d+)$/.exec(path); if (pr && state.prs.has(Number(pr[1]))) return Response.json(state.prs.get(Number(pr[1])));
      const compare = /^compare\/(.+)$/.exec(path); if (compare && state.compare.has(compare[1]!)) return Response.json({ status: state.compare.get(compare[1]!) });
      throw new Error(`Unexpected provider read ${path}`); }) as typeof fetch });
  const source = { schemaVersion: 1, trigger: "local", channel: "local", repository: PUB, branch: feature, headSha: tested } as const;
  const packet = { schemaVersion: 1, occurrenceId, sourceStatus: "recorded", source, requestId: "local-notes-1", routine: { id: "notes-phone" },
    build: { hashes: {} }, delivery: { state: "acknowledged", agentRunId: anchor }, evidence: { complete: true, assets: [] } } as unknown as FailurePacket;
  // The same state object the provider reads, so a test's reassignment (for example of `listed`) reaches it.
  return Object.assign(state, { origin, fix, gateway, packet, frozen: structuredClone(source) });
}

test("the signed grant carries a strict optional destination; legacy grants are unchanged", () => {
  for (const destination of [merged(), open(), undefined]) {
    const grant = grantFor(destination);
    expect(verifyTestContinuationGrant(signTestContinuationGrant(grant, secret), occurrenceId, secret, "dev")).toEqual(grant);
  }
  const tampered: unknown[] = [{ ...merged(), extra: true }, { ...merged(), baseBranch: "main" }, { ...merged(), baseBranch: feature },
    { ...merged(), repository: "Mentra-Community/Mentra-Automated-Testing" }, { ...merged(), sourceOrigin: { pullRequest: 4277, state: "merged" } },
    { ...open(), sourceOrigin: { pullRequest: 4277, state: "open", mergeCommitSha: merge } }, { ...merged(), sourceOrigin: { pullRequest: 0, state: "merged", mergeCommitSha: merge } },
    { ...merged(), sourceOrigin: { pullRequest: 4277, state: "closed" } }, { ...merged(), sourceOrigin: { pullRequest: 4277, state: "merged", mergeCommitSha: "MERGE" } }];
  // Core never signs one, and a correctly signed but tampered grant (as the controller signs it) never verifies.
  const forge = (value: unknown) => { const encoded = Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("hex")}`; };
  expect(verifyTestContinuationGrant(forge(grantFor(merged())), occurrenceId, secret, "dev")).toEqual(grantFor(merged()));
  for (const executionDestination of tampered) {
    expect(() => signTestContinuationGrant({ ...grantFor(undefined), executionDestination } as ContinuationGrant, secret)).toThrow();
    expect(verifyTestContinuationGrant(forge({ ...grantFor(undefined), executionDestination }), occurrenceId, secret, "dev")).toBeNull();
  }
});

test("a merged origin's saved destination admits the new anchor fix PR into dev; the local source is unchanged", async () => {
  const f = provider();
  expect(await f.gateway.target(f.packet, grantFor(merged()), "notes-phone")).toEqual({ query: { channel: "pr", pr: 4300 }, expectedHeadSha: candidateHead, automaticExpected: false });
  expect(f.calls).toEqual([`commits/${tested}/pulls?per_page=100`, "pulls/4277", `compare/${tested}...dev`, `compare/${merge}...dev`, "pulls/4300",
    `compare/${tested}...${candidateHead}`]);
  expect(f.packet.source).toEqual(f.frozen);
  // After the fix PR itself merges, its merged-candidate path verifies the dev publication of its own merge.
  Object.assign(f.fix, { state: "closed", merged: true, merge_commit_sha: candidateMerge, merged_at: "2026-09-29T00:00:00Z" });
  expect(await f.gateway.target(f.packet, grantFor(merged()), "notes-phone")).toEqual({ query: { channel: "dev" }, expectedHeadSha: candidateMerge, automaticExpected: false });
});

test("without a destination the local feature source keeps refusing (the retained reproduction), and replay stays unsupported", async () => {
  const f = provider();
  await expect(f.gateway.target(f.packet, grantFor(undefined), "notes-phone")).rejects.toThrow("Candidate repository, branch, base or current head differs");
  const original = { ...grantFor(merged()), candidate: { repository: PUB, headSha: tested, target: "original" as const } } as ContinuationGrant;
  await expect(f.gateway.target(f.packet, original, "notes-phone")).rejects.toMatchObject({ status: 501 });
  const harness = { ...grantFor(merged()), candidate: { repository: "Mentra-Community/Mentra-Automated-Testing" as const, pullRequest: 12, headSha: candidateHead } };
  await expect(f.gateway.target(f.packet, harness, "notes-phone")).rejects.toMatchObject({ status: 501 });
});

test("an unproven, ambiguous, incomplete, foreign, retargeted or uncontained origin refuses before the candidate is read", async () => {
  const entry = { number: 4277, head: { ref: feature, repo: { full_name: PUB } } };
  const cases: Array<[string, (f: ReturnType<typeof provider>) => void, ContinuationExecutionDestination?]> = [
    ["no associated PR", f => { f.listed = []; }], ["two PRs from the branch", f => { f.listed = [entry, { ...entry, number: 4280 }]; }],
    ["a full page", f => { f.listed = [entry, ...Array.from({ length: 99 }, (_, i) => ({ number: 5000 + i, head: { ref: `other-${i}`, repo: { full_name: PUB } } }))]; }],
    ["an incomplete entry", f => { f.listed = [{ number: 4277 }]; }], ["only a fork's PR", f => { f.listed = [{ ...entry, head: { ...entry.head, repo: { full_name: "someone/MentraOS" } } }]; }],
    ["another PR than the signed one", f => { f.listed = [{ ...entry, number: 4278 }]; }],
    ["an origin record from another branch", f => { f.origin.head.ref = "codex/other"; }], ["an origin record from a fork", f => { f.origin.head.repo = { full_name: "someone/MentraOS" }; }],
    ["an origin retargeted to staging", f => { f.origin.base.ref = "staging"; }], ["a foreign origin base", f => { f.origin.base.repo.full_name = "someone/MentraOS"; }],
    ["a staging destination for a dev origin", () => undefined, { ...merged(), baseBranch: "staging" }],
    ["another merge commit", () => undefined, { ...merged(), sourceOrigin: { pullRequest: 4277, state: "merged", mergeCommitSha: "9".repeat(40) } }],
    ["an origin whose final head is not the tested commit", f => { f.origin.head.sha = "8".repeat(40); }],
    ["an unmerged origin saved as merged", f => { Object.assign(f.origin, { merged: false, merge_commit_sha: null, merged_at: null }); }],
    ["a tested commit outside dev", f => { f.compare.set(`${tested}...dev`, "behind"); }], ["a merge outside dev", f => { f.compare.set(`${merge}...dev`, "diverged"); }]];
  for (const [label, mutate, destination] of cases) {
    const f = provider(); mutate(f);
    const outcome = await f.gateway.target(f.packet, grantFor(destination ?? merged()), "notes-phone").then(() => "resolved", (error: { status?: number; message?: string }) => `${error.status} ${error.message}`);
    expect(`${label}: ${outcome}`).toMatch(/: 409 /);
    expect(f.calls.includes("pulls/4300"), label).toBe(false);
  }
});

test("the candidate stays exactly this case's new anchor PR into the destination", async () => {
  const cases: Array<[string, (f: ReturnType<typeof provider>) => void, ContinuationGrant?]> = [
    ["the merged origin PR itself", () => undefined, grantFor(merged(), 4277)], ["another anchor's branch", f => { f.fix.head.ref = "codex/routine-run_other"; }],
    ["a candidate into staging", f => { f.fix.base.ref = "staging"; }], ["a fork candidate", f => { f.fix.head.repo = { full_name: "someone/MentraOS" }; }],
    ["a moved candidate head", f => { f.fix.head.sha = "7".repeat(40); }], ["a candidate not descending from the tested commit", f => { f.compare.set(`${tested}...${candidateHead}`, "diverged"); }],
    ["a closed unmerged candidate", f => { f.fix.state = "closed"; }],
    ["a shared-candidate binding", () => undefined, { ...grantFor(merged()), caseBinding: { caseId: "mfc_" + "5".repeat(64), candidateOwnerRunId: "run_owner" } }]];
  for (const [label, mutate, grant] of cases) {
    const f = provider(); mutate(f);
    await expect(f.gateway.target(f.packet, grant ?? grantFor(merged()), "notes-phone"), label).rejects.toMatchObject({ status: 409 });
  }
});

test("a destination never applies to another source: published, originating-PR, local dev/staging or foreign", async () => {
  for (const source of [{ schemaVersion: 1, trigger: "dev", channel: "dev", repository: PUB, branch: "dev", headSha: tested },
    { schemaVersion: 1, trigger: "local", channel: "local", repository: PUB, branch: "dev", headSha: tested },
    { schemaVersion: 1, trigger: "local", channel: "local", repository: PUB, branch: "staging", headSha: tested },
    { schemaVersion: 1, trigger: "pr", channel: "pr", repository: PUB, branch: feature, headSha: tested,
      pullRequest: { number: 4277, headRepository: PUB, baseBranch: "dev", baseSha: "b".repeat(40) } }]) {
    const f = provider(); (f.packet as { source: unknown }).source = source;
    await expect(f.gateway.target(f.packet, grantFor(merged()), "notes-phone")).rejects.toThrow("applies only to a local feature-branch source");
    expect(f.calls).toEqual([]);
  }
});

test("an open origin keeps its own PR; the same PR's later merge verifies normally; a retarget or unmerged close refuses", async () => {
  const setup = () => { const f = provider();
    Object.assign(f.origin, { state: "open", merged: false, merge_commit_sha: null, merged_at: null, head: { sha: candidateHead, ref: feature, repo: { full_name: PUB } } });
    f.prs.set(4277, f.origin); return f; };
  const f = setup();
  expect(await f.gateway.target(f.packet, grantFor(open(), 4277), "notes-phone")).toEqual({ query: { channel: "pr", pr: 4277 }, expectedHeadSha: candidateHead, automaticExpected: false });
  // The saved "open" state names how the route was selected; it does not forbid verifying that same PR after it merges.
  Object.assign(f.origin, { state: "closed", merged: true, merge_commit_sha: merge, merged_at: "2026-09-28T06:27:48Z" });
  expect(await f.gateway.target(f.packet, grantFor(open(), 4277), "notes-phone")).toEqual({ query: { channel: "dev" }, expectedHeadSha: merge, automaticExpected: false });
  // Another PR from the very same feature branch into the same base is still not the originating one.
  const sameBranch = setup(); sameBranch.prs.set(4301, { ...sameBranch.origin, number: 4301 });
  await expect(sameBranch.gateway.target(sameBranch.packet, grantFor(open(), 4301), "notes-phone")).rejects.toThrow("Use the originating PR");
  for (const [label, mutate, grant] of [
    ["a second, arbitrary PR", () => undefined, grantFor(open(), 4300)], ["a retargeted origin", (g: ReturnType<typeof setup>) => { g.origin.base.ref = "staging"; }, undefined],
    ["an origin closed without merging", (g: ReturnType<typeof setup>) => { g.origin.state = "closed"; }, undefined]] as const) {
    const g = setup(); mutate(g);
    await expect(g.gateway.target(g.packet, grant ?? grantFor(open(), 4277), "notes-phone"), label).rejects.toMatchObject({ status: 409 });
  }
});

// The real continuation and dispatch services, the real lease callback and the production gateway, composed.
const previous = { url: process.env.CLOUD_REPORT_AGENT_URL, secret: process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET };
beforeEach(() => { process.env.CLOUD_REPORT_AGENT_URL = "https://mini.example.test"; process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET = secret; });
afterEach(() => {
  if (previous.url === undefined) delete process.env.CLOUD_REPORT_AGENT_URL; else process.env.CLOUD_REPORT_AGENT_URL = previous.url;
  if (previous.secret === undefined) delete process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET; else process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET = previous.secret;
});
function composed() {
  const f = provider(), rows = new Map<string, { inputSha256: string; receipt: TestDispatchReceipt }>();
  let sends = 0, stored: unknown = merged();
  const repository: TestDispatchRepository = {
    get: async id => rows.get(id) ?? null, recent: async () => [...rows.values()].map(value => value.receipt),
    insert: async value => { const before = rows.get(value.receipt.dispatchId); if (before) return { stored: before, created: false };
      rows.set(value.receipt.dispatchId, value); return { stored: value, created: true }; },
    acknowledge: async (id, response) => { const value = rows.get(id)!.receipt; Object.assign(value, { sendState: response ? "accepted" : "unknown", ...response }); return value; },
    claim: async () => null, result: async () => null as never,
  };
  const builds: TestBuildGateway = { inventory: async () => [], resolve: async source => ({ source, title: "Notes fix", headSha: candidateHead, availability: "available",
    archive: { name: "app.zip", sha256: archiveSha256, size: 12 }, buildUrl: "https://github.com/build", createdAt: "2026-09-29T00:00:00Z",
    routines: [{ id: "notes-phone", available: true }] }),
    dispatch: async () => { sends++; return { requestRunId: 90, requestUrl: `https://github.com/${PUB}/actions/runs/90` }; },
    progress: async () => ({ state: "running", requestId: "routine-90-1-4300-notes-phone", message: "Running" }), findExisting: async () => null };
  // Mini's lease route stand-in: verifies the signature and compares the destination with its currently stored route.
  const leaseBodies: Record<string, unknown>[] = [];
  const mini = (async (url: URL, init: RequestInit) => {
    expect(String(url)).toBe("https://mini.example.test/internal/routine-failure-lease");
    const headers = init.headers as Record<string, string>, body = String(init.body);
    expect(createHmac("sha256", secret).update(`mentra-mini-lease-check-v1\n${headers["x-mentra-action-expires"]}\n${body}`).digest("hex")).toBe(headers["x-mentra-action-signature"]);
    const value = JSON.parse(body); leaseBodies.push(value);
    if (JSON.stringify(value.executionDestination ?? null) !== JSON.stringify(stored ?? null)) return new Response(null, { status: 409 });
    return Response.json({ schemaVersion: 1, valid: true, agentRunId: value.agentRunId, leaseGeneration: value.leaseGeneration });
  }) as unknown as typeof fetch;
  const runs = { failureDetail: async () => f.packet, detail: async () => ({}), failureMedia: async () => new Response("") } as unknown as TestRunService;
  const service = new TestContinuationService(runs, new TestDispatchService(repository, builds), builds, f.gateway,
    { list: async () => [...rows.values()].map(row => row.receipt), results: async () => [], claim: async () => null } as never,
    (grant, routineId) => requireContinuationLease(grant, routineId, mini));
  return { ...f, rows, service, leaseBodies, sends: () => sends, store: (value: unknown) => { stored = value; } };
}
const input = { source: { channel: "pr" as const, prNumber: 4300, buildRunId: 80, publicationAttempt: 1 }, routineId: "notes-phone" as const, archiveSha256 };

test("request binds the destination durably, checks it at both lease admissions, and replays without a second send", async () => {
  const f = composed(), grant = grantFor(merged());
  expect(await f.service.request(grant, input)).toMatchObject({ sendState: "accepted", requestRunId: 90 });
  const id = continuationOperationId(grant, "notes-phone"), receipt = f.rows.get(id)!.receipt;
  expect(receipt.continuation).toEqual({ occurrenceId, agentRunId: anchor, candidate: grant.candidate, executionDestination: merged(), executionAttempt: 1, expectedHeadSha: candidateHead });
  expect(f.leaseBodies.map(body => body.executionDestination)).toEqual([merged(), merged()]);
  expect(f.sends()).toBe(1);
  expect(await f.service.request(grant, input)).toMatchObject({ dispatchId: id, sendState: "accepted" });
  expect(f.sends()).toBe(1); expect(f.packet.source).toEqual(f.frozen);
});

test("a different destination cannot borrow the receipt, read its history or list it", async () => {
  const f = composed(), grant = grantFor(merged()); await f.service.request(grant, input);
  const id = continuationOperationId(grant, "notes-phone"), other = grantFor({ ...merged(), sourceOrigin: { pullRequest: 4277, state: "merged", mergeCommitSha: "9".repeat(40) } });
  expect(continuationOperationId(other, "notes-phone")).toBe(id);
  for (const tampered of [other, grantFor(undefined), grantFor({ ...merged(), baseBranch: "staging" })]) {
    await expect(f.service.request(tampered, input)).rejects.toThrow("not found");
    await expect(f.service.detail(tampered, id)).rejects.toThrow("not found");
    expect((await f.service.list(tampered)).reruns).toEqual([]);
  }
  expect(f.sends()).toBe(1);
});

test("a destination changed in the controller's stored route refuses at the lease check, before any send or receipt", async () => {
  const f = composed(); f.store(open());
  await expect(f.service.request(grantFor(merged()), input)).rejects.toThrow("Mini lease changed");
  expect(f.sends()).toBe(0); expect(f.rows.size).toBe(0);
  // Changed between the first check and the final send fence: still refused, still no send and no receipt.
  const g = composed(); let calls = 0;
  const checking = g.service as unknown as { checkLease: (grant: ContinuationGrant, routine: "notes-phone") => Promise<void> };
  const real = checking.checkLease; checking.checkLease = async (grant, routine) => { if (++calls === 2) g.store(undefined); return real(grant, routine); };
  await expect(g.service.request(grantFor(merged()), input)).rejects.toThrow("Mini lease changed");
  expect(calls).toBe(2); expect(g.sends()).toBe(0); expect(g.rows.size).toBe(0);
});
