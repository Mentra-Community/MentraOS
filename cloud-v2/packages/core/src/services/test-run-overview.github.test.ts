import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { GithubTestRunOverview } from "./test-run-overview.github";

const SOURCE = "Mentra-Community/MentraOS", PRIVATE = "Mentra-Community/Mentra-Automated-Testing";
const sha = "a".repeat(40), stamp = "2026-09-24T20:00:00.000Z";
const run = (id: number, title: string, path = "device-routine.yml", status = "queued", repository = PRIVATE) => ({
  id, run_attempt: 1, path: ".github/workflows/" + path, head_branch: "main", head_sha: sha, event: "workflow_dispatch",
  status, conclusion: null, created_at: stamp, updated_at: stamp, display_title: title,
  repository: { full_name: repository }, head_repository: { full_name: repository },
});
const request = (id: number, kind: "pr" | "dev" | "nightly" = "dev") => ({ schemaVersion: kind === "pr" ? 1 : 2,
  kind: "mentra-routine-request", requestId: "routine-" + id + "-1-" + (kind === "pr" ? 4185 : "dev") + "-no-glasses",
  status: "ready", trigger: { repository: SOURCE, workflow: ".github/workflows/request-e2e-routine.yml", runId: id, runAttempt: 1, sha, workflowSha: sha },
  routine: { id: "no-glasses", authorization: kind === "pr" ? "pr-label" : "successful-build" },
  ...(kind === "pr" ? { pullRequest: { number: 4185, headSha: sha } } : { source: { channel: "dev", buildRunId: 100, publicationAttempt: 1 } }),
  ...(kind === "nightly" ? { sequence: { kind: "nightly-ota-call" } } : {}),
  selection: { platform: "ios-on-mac", producer: { runId: 100, publicationAttempt: 1 }, build: { sourceCommit: sha, releaseIdentity: "3.3.0-dev.351" } },
});
function harness() {
  const state = { runs: [run(10, "Device routine request 500 / attempt 1")], requests: new Map<number, ReturnType<typeof request>>([[500, request(500)]]),
    calls: [] as { url: URL; init: RequestInit }[], blockedStatus: "", truncated: false, badRedirect: false, expired: false, ambiguous: false,
    recent: [] as ReturnType<typeof run>[], now: Date.parse(stamp) };
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); state.calls.push({ url, init: init ?? {} });
    const json = (value: unknown) => Response.json(value);
    const zip = (id: number) => zipSync({ "request.json": strToU8(JSON.stringify(state.requests.get(id))) });
    if (url.hostname === "safe.blob.core.windows.net") {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return new Response(zip(Number(url.pathname.slice(1))));
    }
    expect(url.hostname).toBe("api.github.com");
    const base = "/repos/" + PRIVATE;
    if (url.pathname === base + "/actions/runs") {
      if (state.blockedStatus === url.searchParams.get("status")) throw Error("private transport context");
      const rows = state.runs.filter(item => item.status === url.searchParams.get("status"));
      return json({ total_count: state.truncated ? 101 : rows.length, workflow_runs: rows });
    }
    if (url.pathname === base + "/actions/workflows/host-maintenance.yml/runs") return json({ workflow_runs: state.recent });
    const job = /\/actions\/runs\/(\d+)\/attempts\/1\/jobs$/.exec(url.pathname);
    if (job && url.pathname.startsWith(base)) {
      const found = [...state.runs, ...state.recent].find(item => item.id === Number(job[1]))!;
      return json({ total_count: 1, jobs: [{ id: found.id * 100, name: "prepared-worker", status: found.status,
        runner_name: found.status === "queued" ? "" : "Mini-1", started_at: found.status === "queued" ? null : stamp,
        steps: found.status === "in_progress" ? [{ name: "Enter the enrolled worker once", status: "in_progress" }] : [] }] });
    }
    const artifacts = /\/actions\/runs\/(\d+)\/artifacts$/.exec(url.pathname);
    if (artifacts) {
      const id = Number(artifacts[1]), bytes = zip(id);
      const artifact = { id, name: "mentra-routine-request-" + id + "-1", expired: state.expired, size_in_bytes: bytes.length,
        digest: "sha256:" + createHash("sha256").update(bytes).digest("hex"), workflow_run: { id, head_sha: sha } };
      return json({ total_count: state.ambiguous ? 2 : 1, artifacts: state.ambiguous ? [artifact, { ...artifact, id: id + 10000, name: "mentra-routine-request-" + id + "-2" }] : [artifact] });
    }
    const generation = /\/actions\/runs\/(\d+)\/attempts\/1$/.exec(url.pathname);
    if (generation) return json(run(Number(generation[1]), "Request", "request-e2e-routine.yml", "completed", SOURCE));
    const download = /\/actions\/artifacts\/(\d+)\/zip$/.exec(url.pathname);
    if (download) {
      expect(init?.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { location: (state.badRedirect ? "https://untrusted.test/" : "https://safe.blob.core.windows.net/") + download[1] } });
    }
    throw Error("Unexpected endpoint " + url.pathname);
  };
  return { state, gateway: new GithubTestRunOverview({ fetch: fetcher as typeof fetch, token: async () => "synthetic-read-token", now: () => state.now }) };
}
test("lists actual queued/running routine and maintenance jobs with immutable request/build metadata", async () => {
  const { state, gateway } = harness();
  state.runs.push(run(11, "Device routine request 501 / attempt 1", "device-routine.yml", "in_progress"),
    run(12, "Reviewed host maintenance", "host-maintenance.yml", "in_progress"),
    run(13, "Unrelated", "offline-tests.yml", "in_progress"));
  state.requests.set(501, request(501, "pr"));
  const result = await gateway.activity();
  expect(result.warnings).toEqual([]);
  expect(result.jobs).toHaveLength(3);
  expect(result.jobs[0]?.requests[0]).toMatchObject({ trigger: "successful-build", channel: "dev", release: "3.3.0-dev.351", buildRunId: 100, platform: "ios-on-mac" });
  expect(result.jobs[1]).toMatchObject({ state: "running", workerName: "Mini-1", workflow: { step: "Enter the enrolled worker once" } });
  expect(result.jobs[1]?.requests[0]).toMatchObject({ trigger: "pr-label", prNumber: 4185 });
  expect(result.jobs[2]?.kind).toBe("maintenance");
  expect(result.jobs[2]?.claims).toEqual([]);
  const count = state.calls.length; await gateway.activity(); expect(state.calls).toHaveLength(count);
});
test("nightly retains both source requests without pretending both routines are currently executing", async () => {
  const { state, gateway } = harness();
  state.runs = [run(20, "Nightly OTA request 500 then Call request 501", "nightly-device-routines.yml", "in_progress")];
  state.requests.set(500, request(500, "nightly")); state.requests.set(501, request(501, "nightly"));
  const result = await gateway.activity();
  expect(result.jobs).toHaveLength(1); expect(result.jobs[0]?.kind).toBe("nightly");
  expect(result.jobs[0]?.requests.map(item => item.trigger)).toEqual(["nightly", "nightly"]);
  expect(result.jobs[0]?.claims).toEqual([]);
});
test("ambiguous nightly attempt, expired metadata or rejected storage host never hide the active job", async () => {
  for (const failure of ["ambiguous", "expired", "badRedirect"] as const) {
    const { state, gateway } = harness(); state[failure] = true;
    if (failure === "ambiguous") state.runs = [run(20, "Nightly OTA request 500 then Call request 501", "nightly-device-routines.yml")];
    const result = await gateway.activity();
    expect(result.jobs).toHaveLength(1); expect(result.jobs[0]?.requests).toEqual([]);
    expect(result.jobs[0]?.message).toContain("unavailable");
    expect(state.calls.some(call => call.url.hostname === "untrusted.test")).toBe(false);
  }
});
test("queue fetch failures and truncation remain explicit and completed maintenance is not a routine verdict", async () => {
  const { state, gateway } = harness(); state.blockedStatus = "in_progress"; state.truncated = true;
  state.recent = [{ ...run(40, "Reviewed host maintenance", "host-maintenance.yml", "completed"), conclusion: "failure" as any }];
  const result = await gateway.activity();
  expect(result.jobs[0]?.state).toBe("queued"); expect(result.warnings.join(" ")).toContain("could not be refreshed");
  expect(result.warnings.join(" ")).toContain("100-run");
  expect(result.recentMaintenance?.[0]).toMatchObject({ kind: "maintenance", state: "finished", workflow: { conclusion: "failure" } });
  expect(JSON.stringify(result)).not.toContain("private transport");
});
test("a 100-run waiting queue does not poll job detail, and refresh reuses authenticated request metadata", async () => {
  const { state, gateway } = harness(); state.runs = [];
  for (let i = 0; i < 100; i++) {
    state.runs.push(run(i + 1000, "Device routine request " + (i + 500) + " / attempt 1"));
    state.requests.set(i + 500, request(i + 500));
  }
  expect((await gateway.activity()).jobs).toHaveLength(100);
  expect(state.calls.filter(call => call.url.pathname.endsWith("/jobs"))).toHaveLength(0);
  const before = state.calls.length; state.now += 16_000;
  expect((await gateway.activity()).jobs).toHaveLength(100);
  expect(state.calls.slice(before)).toHaveLength(6); // Five statuses and recent maintenance only.
});
test("stable active details are cached and a state change invalidates that cache", async () => {
  const { state, gateway } = harness(); state.runs[0]!.status = "in_progress";
  await gateway.activity(); state.now += 16_000; await gateway.activity();
  expect(state.calls.filter(call => call.url.pathname.endsWith("/jobs"))).toHaveLength(1);
  state.runs[0]!.status = "waiting"; state.now += 16_000; await gateway.activity();
  expect(state.calls.filter(call => call.url.pathname.endsWith("/jobs"))).toHaveLength(2);
});
test("administrative closure bypasses the display queue cache", async () => {
  const { state, gateway } = harness();
  state.runs = [];
  expect((await gateway.activity()).jobs).toHaveLength(0);
  state.runs = [run(10, "Device routine request 500 / attempt 1")];
  expect((await gateway.activity()).jobs).toHaveLength(0);
  expect((await gateway.activity({ fresh: true })).jobs).toHaveLength(1);
});
