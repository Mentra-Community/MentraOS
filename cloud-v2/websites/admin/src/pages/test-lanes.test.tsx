import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { aliveObservation, noOwnerObservation, resourceProgress, retainedObservation } from "../../../../packages/core/src/types/test-resource-observation.examples";
import type { TestResourceObservation, TestResourceProgress } from "../../../../packages/core/src/types/test-resource-observation.types";
import type { OverviewJob, OverviewRequest, TestRunOverview } from "../../../../packages/core/src/types/test-run-overview.types";
import { TestRunOverviewService, type OverviewClaimRecord } from "../../../../packages/core/src/services/test-run-overview.service";
import { TestResourceObservationService, type StoredTestResourceObservation } from "../../../../packages/core/src/services/test-resource-observation.service";
import { TestRunOverviewView } from "./test-run-overview";

// Every view below is a real Core response: host reports go through the observation service's strict PUT,
// the overview service composes them with claims and GitHub jobs, and the JSON is rendered by the Admin view.
const at = Date.parse("2026-09-28T01:00:00.000Z");
const minutes = (value: number) => value * 60_000;
type Report = { hostId: string; resourceKey?: string; observation: TestResourceObservation; progress?: TestResourceProgress; ago: number };

async function overview(reports: Report[], options: { jobs?: OverviewJob[]; claims?: OverviewClaimRecord[]; published?: string[] } = {}) {
  const rows = new Map<string, StoredTestResourceObservation>();
  let clock = at;
  const service = new TestResourceObservationService({
    get: async (hostId, resourceKey) => structuredClone(rows.get(hostId + "/" + resourceKey) ?? null),
    insert: async value => { const key = value.hostId + "/" + value.resourceKey; if (rows.has(key)) return false; rows.set(key, structuredClone(value)); return true; },
    replace: async (revision, value) => { const key = value.hostId + "/" + value.resourceKey; if (rows.get(key)?.revision !== revision) return false; rows.set(key, structuredClone(value)); return true; },
  }, () => new Date(clock));
  // Reports are applied oldest first, each at its own Core receipt time.
  for (const { hostId, resourceKey = "shared", observation, progress, ago } of [...reports].sort((a, b) => b.ago - a.ago)) {
    clock = at - ago;
    const current = await service.get(hostId, resourceKey);
    await service.put(hostId, resourceKey, { schemaVersion: 1, hostId, resourceKey, expectedRevision: current.revision, observation, ...(progress ? { progress } : {}) });
  }
  const published = new Set(options.published ?? []);
  return JSON.parse(JSON.stringify(await new TestRunOverviewService({
    claims: async () => ({ claims: options.claims ?? [], truncated: false }), latestFixtureClaims: async () => [], results: async () => [],
    adminRequests: async () => [], resourceObservations: async () => ({ rows: [...rows.values()], truncated: false }),
    publishedRunIds: async ids => ids.filter(id => published.has(id)),
  }, { activity: async () => ({ jobs: structuredClone(options.jobs ?? []), warnings: [] }) }, () => new Date(at)).overview())) as TestRunOverview;
}
const render = (data: TestRunOverview, now = at) => renderToStaticMarkup(<TestRunOverviewView data={data} now={now} onResult={() => {}} />);
function section(html: string, label: string) {
  const start = html.indexOf('aria-label="' + label + '"');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</section>", start));
}
function lane(html: string, hostId: string, resourceKey = "shared") {
  const start = html.indexOf('aria-label="Lane ' + hostId + " " + resourceKey + '"');
  expect(start).toBeGreaterThan(-1);
  // The card's content, without its own accessible label.
  return html.slice(html.indexOf(">", start) + 1, html.indexOf("</article>", start));
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");

// The Mini as Root's audit found it (sanitized): the original Mac run is retained by dead PID 28126 with teardown
// reconciliation pending, the phone lane is idle, and two Mac requests are queued. Routine IDs are synthetic.
const retainedRun = "routine-36283320299-1-staging-no-glasses";
const macRetained = (): TestResourceObservation => ({ ...retainedObservation(retainedRun, 28126, "unknown"),
  lastCheckpoint: { available: true, runID: retainedRun, mode: "complete", phase: "evidence", pendingOperation: null,
    pendingReconciliation: { phase: "teardown", stepID: "recover-account-home" } },
  fixture: { checked: true, record: "valid", fixtureID: "mini-ui-unpaired", status: "recovery-required", lastRunID: retainedRun } });
const phone = "android-c682a14252ea";
const phoneIdle = () => noOwnerObservation("routine-36361636525-1-dev-no-glasses-android");
const request = (id: string, extra: Partial<OverviewRequest>): OverviewRequest => ({ requestId: id, requestRunId: Number(id.split("-")[1]), requestAttempt: 1,
  routineId: id.split("-").slice(4).join("-"), trigger: "successful-build", channel: "dev", ...extra });
const job = (id: number, requests: OverviewRequest[], state: OverviewJob["state"] = "queued", extra: Partial<OverviewJob> = {}): OverviewJob => ({
  id: "github-" + id, kind: "routine", state, title: "Device routine request " + requests[0]!.requestRunId + " / attempt 1",
  createdAt: new Date(at - minutes(40)).toISOString(), requests, claims: [],
  workflow: { runId: id, url: "https://github.com/Mentra-Community/Mentra-Automated-Testing/actions/runs/" + id, status: state === "running" ? "in_progress" : "queued",
    updatedAt: new Date(at - minutes(40)).toISOString() }, ...extra });
const dev441 = () => job(36361708884, [request("routine-36361628401-1-dev-no-glasses", { platform: "ios-on-mac", release: "3.3.0-dev.441" })]);
const pr4272 = () => job(36354969828, [request("routine-36354867253-1-4272-account-miniapps", { platform: "ios-on-mac", channel: "pr", prNumber: 4272,
  trigger: "pr-label", headSha: "4272aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })]);
const retainedClaim = (): OverviewClaimRecord => ({ claim: { requestId: retainedRun, requestSha256: "a".repeat(64), workerId: "mentra-device-mini-1",
  fixtureId: "mini-ui-unpaired", executionId: "execution-original", claimedAt: "2026-09-27T07:20:00.000Z", state: "recovery-required",
  settledAt: "2026-09-27T07:40:00.000Z", settlement: { state: "recovery-required", reason: "synthetic" } } });

/** A card's visible summary and its closed per-lane details, as plain text. */
function parts(html: string, hostId: string, resourceKey = "shared") {
  const card = lane(html, hostId, resourceKey), split = card.indexOf("<details");
  expect(split).toBeGreaterThan(-1); expect(card.slice(split)).not.toMatch(/^<details[^>]* open/);
  return { visible: text(card.slice(0, split)), details: text(card.slice(split)), raw: card };
}

describe("lane cards from actual host reports", () => {
  test("Root's audit: the retained Mac lane is recovery required, the stale phone lane is not available, and the queue is per platform", async () => {
    const data = await overview([{ hostId: "mentra-mac-mini", observation: macRetained(), ago: minutes(9) },
      { hostId: "mentra-mac-mini", resourceKey: phone, observation: phoneIdle(), ago: minutes(10) }],
    { jobs: [dev441(), pr4272()], claims: [retainedClaim()] });
    const html = render(data), lanes = section(html, "Test lanes");
    // Lanes are the first thing shown, ahead of the CI request counters and the technical guard wording.
    expect(html.indexOf('aria-label="Test lanes"')).toBeLessThan(html.indexOf(">CI requests<"));
    expect(text(lanes)).toContain("1 recovery required"); expect(text(lanes)).toContain("1 offline or unknown");
    expect(lanes.match(/<article/g)).toHaveLength(2);

    const mac = parts(html, "mentra-mac-mini");
    expect(mac.visible).toContain("mentra-mac-mini · Mac UI lane Recovery required");
    expect(mac.visible).toContain("Work no-glasses · staging build");
    expect(mac.visible).toContain("Status The run holding this lane stopped before its cleanup finished. The lane stays held until that run is recovered.");
    expect(mac.visible).toContain("Last report 9m 0s ago; the hold stays until the host reports again");
    expect(mac.visible).toContain("Responsible Test runner / operator");
    expect(mac.visible).toContain("Next Recover the original run and publish its verified return before the lane takes new work.");
    expect(mac.visible).toContain("Queue 2 queued iOS-on-Mac requests. GitHub assigns runners; this lane is not confirmed for them.");
    // Raw guard mechanics stay in the lane's details.
    expect(mac.visible).not.toMatch(/PID|28126|routine-36283320299|recover-account-home|Glasses|checkpoint|lane-status/);
    expect(mac.details).toContain("Run " + retainedRun); expect(mac.details).toContain("Worker mentra-device-mini-1");
    expect(mac.details).toContain("Owner PID 28126, not running at the last report");
    expect(mac.details).toContain("Glasses scope at that report: unknown, so every pair is excluded.");
    // The old checkpoint is historical: labelled as such, with no age borrowed from the report.
    expect(mac.details).toContain("Last recorded lifecycle checkpoint (time not reported): complete · evidence");
    expect(mac.details).toContain("Pending lifecycle step: teardown / recover-account-home.");
    expect(mac.details).toContain("A dead PID or completed checkpoint does not release this hold.");
    expect(mac.details).toContain("Queued: account-miniapps · PR #4272 · 4272aaaaaa · 40m 0s ago");
    expect(mac.details).toContain("Queued: no-glasses · 3.3.0-dev.441 · 40m 0s ago");
    // A dead retained owner is never running, reserved or free.
    expect(mac.visible + mac.details).not.toMatch(/Running|Reserved, idle|Available|Offline or unknown/);

    const android = parts(html, "mentra-mac-mini", phone);
    expect(android.visible).toContain("mentra-mac-mini · Android phone lane (03BE) Offline or unknown");
    expect(android.visible).toContain("Status No report for 10m 0s, so the lane's current state is unknown.");
    expect(android.visible).toContain("Last report 10m 0s ago; not current");
    expect(android.visible).toContain("Responsible Host operator");
    expect(android.visible).toContain("Next Confirm the host is online and reporting. Until it reports, do not treat the lane as free.");
    expect(android.visible).toContain("Queue No queued Android requests.");
    expect(android.visible).not.toMatch(/Available|Running|c682a14252ea/);
    expect(android.details).toContain("Resource " + phone + " (this phone only) · fixture 03BE, recorded ready");
    expect(android.details).toContain("Host heartbeat: bun tools/mentra-e2e/lane-status.ts --resource android --serial <this phone's serial> --fixture-directory <lane fixture> --publish --interval-seconds 60");
    // The CI counters remain, below the lanes.
    expect(text(html)).toContain("CI requests 0 running 2 queued 0 waiting 1 blocked");
  });

  test("a fresh heartbeat of the same idle phone makes it available; the same data aged past two minutes is offline or unknown again", async () => {
    const data = await overview([{ hostId: "mentra-mac-mini", resourceKey: phone, observation: phoneIdle(), ago: 30_000 }],
      { jobs: [job(36400000001, [request("routine-36400000000-1-dev-no-glasses-android", { platform: "android", release: "3.3.0-dev.442" })])] });
    const fresh = parts(render(data), "mentra-mac-mini", phone).visible;
    expect(fresh).toContain("Available"); expect(fresh).toContain("Last report 30s ago");
    expect(fresh).toContain("Status Free at the last report. A routine still goes through normal admission.");
    expect(fresh).not.toContain("Responsible");
    expect(fresh).toContain("Queue 1 queued Android request. GitHub assigns runners; this lane is not confirmed for them.");
    const aged = parts(render(data, at + 90_001), "mentra-mac-mini", phone).visible;
    expect(aged).toContain("Offline or unknown"); expect(aged).toContain("not current"); expect(aged).not.toContain("Available");
    // At the bound itself it is still current.
    expect(parts(render(data, at + 90_000), "mentra-mac-mini", phone).visible).toContain("Available");
  });

  test("an active run shows its routine, build and current step, with owner, worker and GitHub link in details; it becomes unconfirmed when reports stop", async () => {
    const run = "routine-36500000000-1-4272-no-glasses";
    const data = await overview([{ hostId: "mentra-mac-mini", observation: aliveObservation(run, 5000, "none"),
      progress: { ...resourceProgress(run, 41, "Replay the shared walkthrough"), phase: "test" }, ago: 20_000 }],
    { jobs: [job(36500000100, [request(run, { platform: "ios-on-mac", channel: "pr", prNumber: 4272, trigger: "pr-label",
      headSha: "abcdef1234567890abcdef1234567890abcdef12" })], "running", { workerName: "mentra-device-mini-1", startedAt: new Date(at - minutes(5)).toISOString() })] });
    const card = parts(render(data), "mentra-mac-mini");
    expect(card.visible).toContain("Running"); expect(card.visible).toContain("Work no-glasses · PR #4272 · abcdef1234 Replay the shared walkthrough · Testing");
    expect(card.visible).toContain("Status Running this routine.");
    expect(card.details).toContain("Worker mentra-device-mini-1");
    expect(card.raw).toContain('href="https://github.com/Mentra-Community/Mentra-Automated-Testing/actions/runs/36500000100"');
    expect(card.details).toContain("Last reported step: Replay the shared walkthrough · Testing, received 20s ago");
    expect(card.details).toContain("Owner PID 5000, alive at the last report");
    expect(card.details).toContain("Glasses scope at that report: verified none. Mac UI, audio and recorder stay held.");
    // No refresh for five minutes: a stale live PID is not a running job, and the old step is not shown as current.
    const stale = parts(render(data, at + minutes(5)), "mentra-mac-mini");
    expect(stale.visible).toContain("Offline or unknown");
    expect(stale.visible).toContain("Status The last report, 5m 20s ago, showed a live owner. Whether it is still running is unknown.");
    expect(stale.visible).toContain("Next Confirm the host is online and reporting. Until it reports, treat the lane as in use.");
    expect(stale.visible).not.toMatch(/Running|Reserved|Replay the shared walkthrough/);
    expect(stale.details).toContain("Last reported step: Replay the shared walkthrough · Testing, received 5m 20s ago");
  });

  test("a fresh heartbeat never makes an old checkpoint current: a reserved lane, a completed step and a local session are not running", async () => {
    const run = "routine-36600000000-1-dev-no-glasses", session = "discovery-46e1b113-108e-4769-8678-3bd2b8d10777";
    const data = await overview([
      // Progress was accepted ten minutes ago; heartbeats since then refreshed only the observation.
      { hostId: "mentra-mac-mini", observation: aliveObservation(run, 6000), progress: { ...resourceProgress(run, 9), phase: "test" }, ago: minutes(10) },
      { hostId: "mentra-mac-mini", observation: aliveObservation(run, 6000), ago: 10_000 },
      { hostId: "mentra-mac-mini", resourceKey: phone, observation: { ...aliveObservation(run + "-android", 6100) }, progress: { ...resourceProgress(run + "-android", 3), mode: "complete" }, ago: 5_000 },
      { hostId: "macbook-dev", observation: aliveObservation(session, 7000), ago: 5_000 },
    ], { jobs: [dev441()] });
    const html = render(data);
    const ci = parts(html, "mentra-mac-mini");
    expect(ci.visible).toContain("Reserved, idle"); expect(ci.visible).toContain("Status Held by a CI run with no step reported for 10m 0s.");
    expect(ci.visible).toContain("Work no-glasses · dev build · build details not reported"); expect(ci.visible).not.toContain("Stop recording");
    expect(ci.visible).toContain("Last report 10s ago");
    expect(ci.details).toContain("Last reported step: Stop recording · Testing, received 10m 0s ago");
    expect(ci.visible).toContain("Next Wait for the run to continue, or ask its test runner to stop it.");
    const completed = parts(html, "mentra-mac-mini", phone);
    expect(completed.visible).toContain("Reserved, idle"); expect(completed.details).toContain("(completed)");
    const dev = parts(html, "macbook-dev");
    expect(dev.visible).toContain("macbook-dev · Mac UI lane Reserved, idle"); expect(dev.visible).toContain("Work Local session, not a CI request");
    expect(dev.visible).toContain("Status Held by a local session with no step reported.");
    expect(dev.visible).toContain("Responsible Session owner"); expect(dev.visible).toContain("Next Ask the session owner to finish or stop the session.");
    // A development lane that never ran CI is not offered queued CI work.
    expect(dev.visible).toContain("Queue No CI run was seen on this lane, so no CI queue is shown.");
    expect(dev.details).toContain("Run " + session); expect(dev.details).not.toContain("Worker");
    expect(ci.visible).toContain("Queue 1 queued iOS-on-Mac request.");
  });

  test("an open app or a generic GitHub job is not a running lane; only the guard owner's exact request is", async () => {
    // GitHub reports a job in progress, but the lane's guard has no owner: the lane is available, not running.
    const data = await overview([{ hostId: "mentra-mac-mini", observation: noOwnerObservation("routine-36600000000-1-dev-no-glasses"), ago: 5_000 }],
      { jobs: [job(36700000000, [request("routine-36700000000-1-dev-no-glasses", { platform: "ios-on-mac" })], "running", { workerName: "mentra-device-mini-1" })] });
    const card = parts(render(data), "mentra-mac-mini");
    expect(card.visible).toContain("Available"); expect(card.visible).not.toMatch(/Running|Work/);
  });

  test("a configured MacBook appears only once it reports; the view lists only reporting hosts", async () => {
    const withMacBook = section(render(await overview([{ hostId: "mentra-mac-mini", resourceKey: phone, observation: phoneIdle(), ago: 5_000 },
      { hostId: "macbook-dev", observation: noOwnerObservation("discovery-46e1b113-108e-4769-8678-3bd2b8d10777"), ago: 5_000 }])), "Test lanes");
    expect(withMacBook).toContain('aria-label="Lane macbook-dev shared"'); expect(withMacBook.match(/<article/g)).toHaveLength(2);
    const without = section(render(await overview([{ hostId: "mentra-mac-mini", resourceKey: phone, observation: phoneIdle(), ago: 5_000 }])), "Test lanes");
    expect(without).not.toContain("macbook"); expect(without.match(/<article/g)).toHaveLength(1);
    expect(text(without)).toContain("Hosts that have not reported are not listed.");
  });

  test("absent, failed and empty feeds and older producers keep unknown facts explicit", async () => {
    const legacy = await overview([]);
    delete legacy.resourceObservations;
    expect(text(section(render(legacy), "Test lanes"))).toContain("Lane state was not reported by Core. Do not treat any lane as free.");
    const failed = await overview([]);
    failed.resourceObservations = { available: false, truncated: false, items: [] };
    expect(text(section(render(failed), "Test lanes"))).toContain("Lane state could not be loaded. Do not treat any lane as free.");
    expect(text(section(render(await overview([])), "Test lanes"))).toContain("No host has reported a lane yet.");
    // An older producer: no glasses scope, no progress; a queued request without a reported platform.
    const older = await overview([{ hostId: "mini-older", observation: aliveObservation("routine-7-1-dev-no-glasses"), ago: 5_000 }],
      { jobs: [job(8, [request("routine-9-1-dev-no-glasses", {})])] });
    const html = render(older), card = parts(html, "mini-older");
    expect(card.visible).toContain("Work no-glasses · dev build · build details not reported");
    expect(card.details).toContain("Glasses scope at that report: unknown, so every pair is excluded.");
    expect(card.details).toContain("Worker not reported"); expect(card.visible).toContain("Queue No queued iOS-on-Mac requests.");
    expect(text(section(html, "Test lanes"))).toContain("1 queued request does not report a platform and is not shown on a lane.");
  });

  test("fresh fixture records that need recovery or commissioning are not available", async () => {
    const recorded = (status: "recovery-required" | "uncommissioned"): TestResourceObservation => ({ state: "idle-prerequisite-blocked",
      reason: status === "uncommissioned" ? "recorded-fixture-uncommissioned" : "recorded-fixture-recovery-required",
      guard: { lock: "absent", reclaimMarker: "absent" }, fixture: { checked: true, record: "valid", fixtureID: "03BE", status, lastRunID: "routine-1-1-dev-no-glasses" } });
    const html = render(await overview([{ hostId: "mini-a", observation: recorded("recovery-required"), ago: 5_000 },
      { hostId: "mini-b", observation: recorded("uncommissioned"), ago: 5_000 }]));
    expect(parts(html, "mini-a").visible).toContain("Recovery required");
    expect(parts(html, "mini-a").visible).toContain("Next Recover the fixture and publish verified return evidence before routines use it.");
    expect(parts(html, "mini-b").visible).toContain("Not ready"); expect(parts(html, "mini-b").visible).toContain("Responsible Operator");
  });

  test("guard wording and CI history are behind a closed Technical details disclosure", async () => {
    const data = await overview([{ hostId: "mentra-mac-mini", observation: macRetained(), ago: minutes(1) }], { jobs: [dev441()], claims: [retainedClaim()] });
    data.fixtureAttention = [{ ...dev441(), id: "claim-old", kind: "fixture", state: "blocked", claims: [{ requestId: "old", workerId: "mentra-device-mini-1", fixtureId: "03BE",
      claimedAt: new Date(at - minutes(600)).toISOString() }], attention: { reason: "Physical return remains unverified.", responsible: "Test runner / operator",
      nextAction: "Recover the fixture.", cancelledAt: new Date(at - minutes(500)).toISOString() } }];
    const html = render(data);
    const details = html.slice(html.indexOf('<details class="mt-5 text-xs" aria-label="Technical details">'));
    expect(details.startsWith('<details class="mt-5 text-xs" aria-label="Technical details"><summary')).toBe(true);
    expect(details).toContain("Technical details: host guard observations and CI history");
    const before = html.slice(0, html.length - details.length);
    for (const technical of ["Local resource observations", "Latest CI return evidence after resolved follow-up", "Shared guard: Mac UI and Mac audio"]) {
      expect(details).toContain(technical); expect(before).not.toContain(technical);
    }
    expect(before).toContain('aria-label="Test lanes"');
  });
});
