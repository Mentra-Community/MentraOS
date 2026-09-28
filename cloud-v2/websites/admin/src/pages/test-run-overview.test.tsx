import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { aliveObservation, noOwnerObservation, resourceProgress, retainedObservation } from "../../../../packages/core/src/types/test-resource-observation.examples";
import type { TestResourceObservation } from "../../../../packages/core/src/types/test-resource-observation.types";
import type { OverviewJob, OverviewResourceObservation, TestRunOverview } from "../../../../packages/core/src/types/test-run-overview.types";
import { TestRunOverviewService, type OverviewClaimRecord, type TestRunOverviewRepository } from "../../../../packages/core/src/services/test-run-overview.service";
import { TestResourceObservationService, type StoredTestResourceObservation } from "../../../../packages/core/src/services/test-resource-observation.service";
import { elapsed, resourceStatus, TestRunOverviewView } from "./test-run-overview";

const stamp = "2026-09-24T20:00:00.000Z";
const data = (): TestRunOverview => ({ observedAt: stamp, warnings: [], resolvedRecoveries: [], recentMaintenance: [], fixtureSummary: [], jobs: [{
  id: "synthetic", title: "Routine", kind: "routine", state: "running", createdAt: stamp, startedAt: stamp,
  requests: [{ requestId: "request-1", requestRunId: 500, requestAttempt: 1, routineId: "no-glasses-android", channel: "dev",
    trigger: "successful-build", platform: "android", release: "3.3.0-dev.351" }], workerName: "Mini-1", claims: [{ requestId: "request-1", workerId: "mini", fixtureId: "samsung-phone-only", claimedAt: stamp,
    progress: { sequence: 22, mode: "running", phase: "test", step: { id: "walkthrough", label: "Walk through app" },
      completedSteps: 0, totalSteps: 1, receivedAt: stamp,
      action: { id: "open-settings", label: "Open Settings", completedActions: 7, totalActions: null } } }],
  workflow: { runId: 10, url: "https://github.com/Mentra-Community/Mentra-Automated-Testing/actions/runs/10", status: "in_progress", step: "Enter the enrolled worker once", updatedAt: stamp },
}] });
test("shows the actual reported action and distinguishes phase counts from an unknown action total", () => {
  const html = renderToStaticMarkup(<TestRunOverviewView data={data()} now={Date.parse(stamp) + 180_000} onResult={() => {}} />);
  expect(html).toContain("Open Settings"); expect(html).toContain("Testing");
  expect(html).not.toContain("Lifecycle steps");
  expect(html).toContain("7 actions completed; total unknown");
  expect(html).toContain("No recent checkpoint; activity is unconfirmed");
  expect(html).toContain("GitHub step: Enter the enrolled worker once");
  expect(html).toContain("samsung-phone-only"); expect(html).toContain("Android · Automatic build");
  expect(html).not.toContain("% complete");
});
test("fresh action progress is concise, while workflow details remain a fallback", () => {
  const value = data();
  value.jobs[0]!.claims[0]!.progress!.action!.totalActions = 38;
  let html = renderToStaticMarkup(<TestRunOverviewView data={value} now={Date.parse(stamp) + 15_000} onResult={() => {}} />);
  expect(html).toContain("7 of 38 actions completed"); expect(html).toContain("Testing");
  expect(html).not.toContain("Lifecycle steps"); expect(html).not.toContain("GitHub step:");
  value.jobs[0]!.claims[0]!.progress!.action = null;
  html = renderToStaticMarkup(<TestRunOverviewView data={value} now={Date.parse(stamp) + 15_000} onResult={() => {}} />);
  expect(html).toContain("Lifecycle steps 0/1 in this phase");
  value.jobs[0]!.claims[0]!.progress!.mode = "complete";
  html = renderToStaticMarkup(<TestRunOverviewView data={value} now={Date.parse(stamp) + 15_000} onResult={() => {}} />);
  expect(html).toContain("GitHub step: Enter the enrolled worker once");
  value.jobs[0]!.claims = [];
  html = renderToStaticMarkup(<TestRunOverviewView data={value} now={Date.parse(stamp) + 15_000} onResult={() => {}} />);
  expect(html).toContain("GitHub step: Enter the enrolled worker once");
});
test("a completed first nightly member cannot hide the next member's workflow step", () => {
  const value = data();
  const job = value.jobs[0]!;
  job.kind = "nightly";
  job.claims[0]!.progress!.mode = "complete";
  job.requests.push({...job.requests[0]!, requestId: "request-2", routineId: "mentra-call"});
  job.workflow!.step = "Run the requested Call routine";
  const html = renderToStaticMarkup(<TestRunOverviewView data={value} now={Date.parse(stamp) + 15_000} onResult={() => {}} />);
  expect(html).toContain("Completed checkpoint");
  expect(html).toContain("GitHub step: Run the requested Call routine");
});
test("missing progress and partial outages never render an empty-success message", () => {
  const value = data(); value.jobs[0]!.claims = [];
  let html = renderToStaticMarkup(<TestRunOverviewView data={value} now={Date.parse(stamp)} onResult={() => {}} />);
  expect(html).toContain("No routine checkpoint reported.");
  value.jobs = []; value.warnings = ["GitHub unavailable"];
  html = renderToStaticMarkup(<TestRunOverviewView data={value} now={Date.parse(stamp)} onResult={() => {}} />);
  expect(html).toContain("No activity could be confirmed"); expect(html).not.toContain("No active jobs or unresolved claims");
});
test("maintenance failures are separate from routine verdicts, with original/recovery links preserved", () => {
  const value = data(); value.jobs = [];
  value.recentMaintenance = [{ ...data().jobs[0]!, kind: "maintenance", state: "finished", workflow: { ...data().jobs[0]!.workflow!, conclusion: "failure" } }];
  value.resolvedRecoveries = [{ requestId: "request-1", fixtureId: "03BE", originalRunId: "original", recoveryRunId: "recovery-2" }];
  const html = renderToStaticMarkup(<TestRunOverviewView data={value} now={Date.parse(stamp)} onResult={() => {}} />);
  expect(html).toContain("host job outcomes, not routine test verdicts"); expect(html).toContain("failure");
  expect(html).toContain("Original result"); expect(html).toContain("Recovery result");
  expect(elapsed(stamp, Date.parse(stamp) + 61_000)).toBe("1m 1s");
});
test("blocked work names a reason, responsible role and next action without pretending user input is required", () => {
  const value = data(); value.jobs[0]!.state = "blocked";
  value.jobs[0]!.attention = { reason: "Cleanup did not pass.", responsible: "Test runner / operator",
    nextAction: "Publish verified return evidence.", cancelRequestId: "request-1" };
  value.jobs[0]!.resultRunId = "original";
  const html = renderToStaticMarkup(<TestRunOverviewView data={value} now={Date.parse(stamp)} onResult={() => {}} onCancel={async () => {}} />);
  expect(html).toContain("Cleanup did not pass."); expect(html).toContain("Responsible: Test runner / operator");
  expect(html).toContain("Next: Publish verified return evidence."); expect(html).toContain("Cancel further work");
  expect(html).toContain("Recorded result"); expect(html).not.toContain("Waiting for user");
});
test("cancelled work is absent from live job counts while physical readiness has a separate section", () => {
  const value = data(); value.fixtureAttention = [{ ...value.jobs[0]!, kind: "fixture", state: "blocked", attention: {
    reason: "Physical return remains unverified.", responsible: "Test runner / operator", nextAction: "Recover the fixture.", cancelledAt: stamp } }];
  value.jobs = [];
  const html = renderToStaticMarkup(<TestRunOverviewView data={value} now={Date.parse(stamp)} onResult={() => {}} onCancel={async () => {}} />);
  expect(html).toContain("<strong>0</strong> blocked"); expect(html).toContain("Latest CI return evidence after resolved follow-up");
  expect(html).toContain("Resolved follow-up history (1)"); expect(html).toContain("keep their original results");
  // Without a Core summary, nothing is presented as ready.
  expect(html).toContain("CI return evidence was not reported by Core. Treat these fixtures as unverified.");
  expect(html).not.toContain("Cancel further work"); expect(html).not.toContain(">returned<");
  expect(html).toContain("No active jobs. Some CI return evidence below is not verified.");
  expect(html).not.toContain("No active jobs or unresolved claims");
});
test("a closed claim is history with its failed result and uncommissioned fixture, not a live block or pass", () => {
  const value = data(); value.fixtureAttention = [{ ...value.jobs[0]!, kind: "fixture", state: "finished", title: "Closed without a test",
    resultRunId: "request-1", attention: { reason: "Android refused the selected app update.", responsible: "Test runner / operator",
      nextAction: "Commission this fixture before another request.", closedAt: stamp } }];
  value.fixtureSummary = [{ workerId: "mini-1", fixtureId: "phone", cancelledRequestIds: ["request-1"], latestCancelledClaimAt: stamp, status: "unverified" }];
  value.jobs = [];
  const html = renderToStaticMarkup(<TestRunOverviewView data={value} now={Date.parse(stamp)} onResult={() => {}} onCancel={async () => {}} />);
  expect(html).toContain("<strong>0</strong> blocked"); expect(html).toContain("Closed by its original worker 0s ago; no test ran and the fixture was left uncommissioned");
  expect(html).toContain("Recorded result"); expect(html).toContain(">unverified<"); expect(html).not.toContain(">returned<");
  expect(html).not.toContain("Cancel further work"); expect(html).toContain("No active jobs. Some CI return evidence below is not verified.");
});
test("shared history names cancelled and owner-closed requests neutrally while each entry keeps its own resolution", () => {
  const value = data(); const base = value.jobs[0]!;
  const entry = (id: string, attention: NonNullable<typeof base.attention>) => ({ ...base, id: "claim-" + id, kind: "fixture" as const,
    state: "finished" as const, workflow: undefined, resultRunId: "original-" + id,
    requests: [{ ...base.requests[0]!, requestId: id, routineId: "no-glasses-" + id }],
    claims: [{ requestId: id, workerId: "mini-1", fixtureId: "phone", claimedAt: stamp }], attention });
  value.fixtureAttention = [
    entry("cancelled", { reason: "Physical return remains unverified.", responsible: "Test runner / operator", nextAction: "Recover the fixture.", cancelledAt: stamp }),
    entry("closed", { reason: "Android refused the selected app update.", responsible: "Test runner / operator",
      nextAction: "Commission this fixture before another request.", closedAt: stamp }),
  ];
  value.fixtureSummary = [{ workerId: "mini-1", fixtureId: "phone", cancelledRequestIds: ["closed", "cancelled"], latestCancelledClaimAt: stamp, status: "unverified" }];
  value.jobs = [];
  const html = renderToStaticMarkup(<TestRunOverviewView data={value} now={Date.parse(stamp)} onResult={() => {}} />);
  expect(html).not.toMatch(/cancelled attempt/i);
  expect(html).toContain("Latest CI return evidence after resolved follow-up"); expect(html).toContain("Cancelled and closed requests keep their original results.");
  expect(html).toContain("2 resolved requests before it"); expect(html).toContain("No newer claim on this worker and fixture since the newest resolved request.");
  expect(html).toContain("No active jobs. Some CI return evidence below is not verified.");
  const history = html.slice(html.indexOf("Resolved follow-up history (2)"));
  const [cancelled, closed] = history.split("no-glasses-closed");
  expect(cancelled).toContain("no-glasses-cancelled"); expect(cancelled).toContain("Follow-up cancelled 0s ago"); expect(cancelled).not.toContain("Closed by its original worker");
  expect(closed).toContain("Closed by its original worker 0s ago; no test ran and the fixture was left uncommissioned"); expect(closed).not.toContain("Follow-up cancelled");
  expect(history.match(/Recorded result/g)).toHaveLength(2);
});
test("late export and missing original recovery links describe only evidence that actually exists", () => {
  const value = data(); value.jobs = []; value.resolvedRecoveries = [
    { requestId: "request-1", originalRunId: "request-1", recoveryRunId: "request-1", fixtureId: "phone", kind: "late-result", originalAvailable: true },
    { requestId: "request-2", originalRunId: "request-2", recoveryRunId: "recovery-5", fixtureId: "03BE", kind: "recovery", originalAvailable: false },
  ];
  const html = renderToStaticMarkup(<TestRunOverviewView data={value} now={Date.parse(stamp)} onResult={() => {}} />);
  expect(html).toContain("Completed result"); expect(html).toContain("Original result not published");
  expect(html).toContain("Recovery result"); expect(html).not.toContain(">Original result</button>");
});

test("one readiness row per worker/fixture shows its newest claim; every cancelled attempt stays in history", () => {
  const value = data(); const live = value.jobs[0]!;
  live.state = "blocked"; live.claims[0] = { ...live.claims[0]!, requestId: "phone-active", workerId: "mini-1", fixtureId: "android-phone" };
  const attempt = (id: string, workerId: string, fixtureId: string) => ({ ...data().jobs[0]!, id: "claim-" + id, kind: "fixture" as const,
    state: "blocked" as const, resultRunId: "original-" + id, workflow: undefined,
    requests: [{ ...data().jobs[0]!.requests[0]!, requestId: id, routineId: "no-glasses-" + id }],
    claims: [{ requestId: id, workerId, fixtureId, claimedAt: stamp }],
    attention: { reason: "Cleanup did not pass; physical return is unverified.", responsible: "Test runner / operator" as const,
      nextAction: "Complete recovery for this request and publish its verified return evidence.", cancelledAt: stamp } });
  value.fixtureAttention = [attempt("u1", "mini-1", "mini-ui-unpaired"), attempt("u2", "mini-1", "mini-ui-unpaired"),
    attempt("u3", "mini-1", "mini-ui-unpaired"), attempt("g1", "mini-1", "glasses-03be"), attempt("o1", "mini-2", "mini-ui-unpaired"),
    attempt("p1", "mini-1", "android-phone"), attempt("t1", "mini-1", "tablet")];
  const later = new Date(Date.parse(stamp) + 3_600_000).toISOString();
  value.fixtureSummary = [
    { workerId: "mini-1", fixtureId: "android-phone", status: "current-work", cancelledRequestIds: ["p1"], latestCancelledClaimAt: stamp,
      latest: { requestId: "phone-active", claimedAt: later, reason: "This newer claim still owns the fixture; follow it in Live activity." } },
    { workerId: "mini-1", fixtureId: "tablet", status: "not-checked", cancelledRequestIds: ["t1"], latestCancelledClaimAt: stamp },
    { workerId: "mini-1", fixtureId: "glasses-03be", status: "unverified", cancelledRequestIds: ["g1"], latestCancelledClaimAt: stamp,
      latest: { requestId: "glasses-failure", claimedAt: later, reason: "The recorded run left the fixture unavailable.", resultRunId: "glasses-failure" } },
    { workerId: "mini-2", fixtureId: "mini-ui-unpaired", status: "unverified", cancelledRequestIds: ["o1"], latestCancelledClaimAt: stamp },
    { workerId: "mini-1", fixtureId: "mini-ui-unpaired", status: "latest-return-verified", cancelledRequestIds: ["u3", "u2", "u1"], latestCancelledClaimAt: stamp,
      latest: { requestId: "routine-36080522386-1-dev-no-glasses", claimedAt: later, reason: "Verified return evidence is published.",
        resultRunId: "routine-36080522386-1-dev-no-glasses" } },
  ];
  const html = renderToStaticMarkup(<TestRunOverviewView data={value} now={Date.parse(later) + 60_000} onResult={() => {}} />);
  const section = html.slice(html.indexOf("Latest CI return evidence after resolved follow-up"));
  const [summary, history] = section.split("Resolved follow-up history");
  // One compact row per worker/fixture; no per-attempt blocked wall or per-request recovery instruction.
  expect(summary!.match(/<tr class="border-t/g)).toHaveLength(5);
  expect(summary).not.toContain(">blocked<"); expect(section).not.toContain("Complete recovery for this request");
  for (const [count, badge] of [[1, "in use"], [1, "not checked"], [2, "unverified"], [1, "returned"]] as const)
    expect(summary).toContain("<strong>" + count + "</strong> " + badge + "</span>");
  expect(summary).toContain("Latest claim routine-36080522386-1-dev-no-glasses, 1m 0s ago: cleanup and return were verified.");
  expect(summary).toContain("3 resolved requests before it");
  expect(summary).toContain("No recovery is needed for the resolved requests. Use outside routine claims is not observed here; see Local resource observations.");
  expect(summary).toContain("Latest claim glasses-failure, 1m 0s ago: The recorded run left the fixture unavailable.");
  expect(summary).toContain("Latest claim phone-active, 1m 0s ago: This newer claim still owns the fixture");
  expect(summary).toContain("Newer claims on this worker and fixture could not be checked.");
  expect(summary).toContain("No newer claim on this worker and fixture since the newest resolved request.");
  expect(summary!.match(/>Result<\/button>/g)).toHaveLength(2);
  // The live blocker remains in the main table, and all original attempts and result links are retained.
  expect(html).toContain("<strong>1</strong> blocked");
  expect(history).toContain("(7)");
  for (const id of ["u1", "u2", "u3", "g1", "o1", "p1", "t1"]) expect(history).toContain("no-glasses-" + id);
  expect(history!.match(/Recorded result/g)).toHaveLength(7);
  expect(history).toContain("Cleanup did not pass; physical return is unverified.");
});

test("a recorded failure is shown apart from the current recovery status, as plain text, without inventing a cause", () => {
  const blocked = (recordedFailure: NonNullable<OverviewJob["attention"]>["recordedFailure"]) => {
    const value = data(); value.jobs[0]!.state = "blocked"; value.jobs[0]!.resultRunId = "original";
    value.jobs[0]!.attention = { reason: "The recorded run left the fixture unavailable.", responsible: "Test runner / operator",
      nextAction: "Complete recovery for this request and publish its verified return evidence.", recordedFailure };
    return renderToStaticMarkup(<TestRunOverviewView data={value} now={Date.parse(stamp)} onResult={() => {}} />);
  };
  // Sample shaped like beta397: lifecycle IDs only; the local signed-out/Home cause was not exported.
  let html = blocked({ resultRunId: "original", detailUnpublished: true,
    failure: { phase: "setup", step: { id: "recording-start", label: "Start recording" }, message: "Phase failed." } });
  const [status, recorded] = html.split('aria-label="Recorded failure"');
  expect(status).toContain("The recorded run left the fixture unavailable."); expect(status).toContain("Responsible: Test runner / operator");
  expect(recorded).toContain("Setup · Start recording (recording-start)"); expect(recorded).toContain("Phase failed.");
  expect(recorded).toContain("The detailed cause was not published with this result.");
  expect(recorded).toContain("not a diagnosis of the current recovery state");
  expect(html).not.toMatch(/signed out|Waiting for user|Your action/i);
  // Sample shaped like Day1: the authored failed chapter and expectation, not which comparison failed.
  html = blocked({ resultRunId: "original", detailUnpublished: false,
    failure: { phase: "test", step: { id: "customer-sequence", label: "Customer sequence" }, message: "Phase failed." },
    chapter: { id: "OTA-03", status: "failed", instruction: "Confirm the January device ID, ASG27 build and IP match", expected: "Device ID, build 27 and IP match" } });
  expect(html).toContain("Test · Customer sequence (customer-sequence)");
  expect(html).toContain("Chapter OTA-03 failed: Confirm the January device ID, ASG27 build and IP match");
  expect(html).toContain("Chapter expected: Device ID, build 27 and IP match"); expect(html).not.toContain("detailed cause was not published");
  html = blocked({ resultRunId: "original", detailUnpublished: true,
    failure: { phase: "evidence", step: { id: "recording-integrity", label: "recording-integrity" }, message: "Phase failed." } });
  expect(html).toContain("Evidence · recording-integrity</p>");
  html = blocked({ resultRunId: "recovery-2", failure: null, detailUnpublished: true });
  expect(html).toContain("This result published no failure step or cause.");
  html = blocked({ resultRunId: "original", detailUnpublished: false,
    failure: { phase: "test", message: "<img src=x onerror=alert(1)>", expected: "<script>x</script>" } });
  expect(html).toContain("Step not reported"); expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
  expect(html).not.toContain("<img"); expect(html).not.toContain("<script>");
});

describe("local resource observations", () => {
  const discovery = "discovery-46e1b113-108e-4769-8678-3bd2b8d10777";
  const later = (ms: number) => new Date(Date.parse(stamp) + ms).toISOString();
  const item = (hostId: string, observation: TestResourceObservation, extra: Partial<OverviewResourceObservation> = {}): OverviewResourceObservation =>
    ({ hostId, resourceKey: "shared", revision: 4, receivedAt: later(3_600_000), observation, publishedRunIds: [], ...extra });
  const view = (items: OverviewResourceObservation[] | undefined, now: number, change: (value: TestRunOverview) => void = () => {}) => {
    const value = data(); value.jobs = [];
    if (items) value.resourceObservations = { available: true, truncated: false, items };
    change(value);
    const html = renderToStaticMarkup(<TestRunOverviewView data={value} now={now} onResult={() => {}} />);
    const start = html.indexOf('aria-label="Local resource observations"');
    return { html, section: html.slice(start, html.indexOf("</section>", start)) };
  };

  test("an older verified CI return and a newer retained local hold are shown separately; age and a dead PID never clear the hold", () => {
    const retained = item("mini-03be", retainedObservation(discovery), { progress: { ...resourceProgress(discovery, 41), mode: "complete", receivedAt: later(3_500_000) } });
    const { html, section } = view([retained], Date.parse(stamp) + 7 * 24 * 3_600_000, value => {
      value.fixtureAttention = [{ ...data().jobs[0]!, id: "claim-old", kind: "fixture", state: "blocked", claims: [{ requestId: "old", workerId: "mini-03be", fixtureId: "03BE", claimedAt: stamp }],
        attention: { reason: "Physical return remains unverified.", responsible: "Test runner / operator", nextAction: "Recover the fixture.", cancelledAt: stamp } }];
      value.fixtureSummary = [{ workerId: "mini-03be", fixtureId: "03BE", status: "latest-return-verified", cancelledRequestIds: ["old"], latestCancelledClaimAt: stamp,
        latest: { requestId: "routine-2-1-dev-day1-ota", claimedAt: stamp, reason: "Verified return evidence is published.", resultRunId: "routine-2-1-dev-day1-ota" } }];
    });
    // The historical CI row keeps its outcome under an explicitly historical heading.
    const ci = html.slice(html.indexOf("Latest CI return evidence after resolved follow-up"));
    expect(ci).toContain(">returned<"); expect(ci).toContain("does not observe local ownership since then");
    expect(html.indexOf("Local resource observations")).toBeLessThan(html.indexOf("Latest CI return evidence"));
    expect(html).not.toContain(">Readiness<"); expect(html).not.toContain("Fixture readiness");
    // The newer local observation stays a retained hold a week later.
    expect(section).toContain(">retained hold<"); expect(section).toContain("PID 4242 · not running when observed");
    expect(section).toContain("Retains the guard for its run on exit"); expect(section).toContain("Completed checkpoint · teardown");
    expect(section).toContain("Pending step: teardown / stop-recording"); expect(section).toContain("Journal checkpoint 41");
    expect(section).toContain("A dead PID or completed checkpoint does not release this hold.");
    expect(section).toContain("Kept until this host reports a newer observation");
    expect(section).toContain("Responsible: Test runner / operator");
    expect(section).toContain("Next: Resume this run&#x27;s recovery through its original owner and publish verified return evidence.");
    expect(section).toContain("Shared guard: Mac UI and Mac audio; its owner&#x27;s glasses scope decides which glasses pairs it excludes");
    // This older-producer example reports no scope: it is shown as unknown, never as none.
    expect(section).toContain("Glasses scope not reported by this host: treated as unknown, so every glasses pair is excluded.");
    // No published result: the run ID is plain text, not a link.
    expect(section).toContain("Run: <span class=\"break-all\">" + discovery + "</span>"); expect(section).not.toContain("<button");
  });

  test("missing, failed and empty feeds are explicit and never imply coverage", () => {
    expect(view(undefined, Date.parse(stamp)).section).toContain("Local resource observations were not reported by Core. Local ownership is not shown; do not treat any host or fixture as free.");
    expect(view([], Date.parse(stamp)).section).toContain("No host has reported a local resource observation. Local ownership is not covered by this view.");
    const failed = view([], Date.parse(stamp), value => { value.resourceObservations = { available: false, truncated: false, items: [] }; }).section;
    expect(failed).toContain("Local resource observations could not be loaded. Local ownership is unknown.");
    const truncated = view([item("mini-1", noOwnerObservation())], Date.parse(stamp), value => { value.resourceObservations!.truncated = true; }).section;
    expect(truncated).toContain("More observations exist than shown.");
  });

  test("a fresh no-owner snapshot is No owner observed, never ready; a stale one is not current", () => {
    const fresh = view([item("mini-1", noOwnerObservation())], Date.parse(later(3_600_000)) + 30_000).section;
    expect(fresh).toContain(">no owner observed<"); expect(fresh).toContain("No owner observed.");
    expect(fresh).toContain("Fixture 03BE: recorded ready"); expect(fresh).toContain("Context only, not admission.");
    expect(fresh).toContain("Next: Nothing to recover from this observation. Recorded fixture state is context; a routine still needs the normal acquisition and prerequisite checks.");
    expect(fresh).not.toMatch(/>ready<|available to|free to use|firmware/i);
    const stale = view([item("mini-1", noOwnerObservation())], Date.parse(later(3_600_000)) + 600_000).section;
    expect(stale).toContain(">not current<"); expect(stale).toContain("No owner was observed at that time; the current state is unconfirmed.");
    expect(stale).toContain("Next: Refresh this observation from the host before relying on it.");
    expect(stale).not.toContain(">no owner observed<");
  });

  test("a fresh live owner names the owning runner; a stale one is unconfirmed rather than a running job", () => {
    const alive = item("mini-1", aliveObservation("run-live"), { progress: { ...resourceProgress("run-live", 3), receivedAt: later(3_590_000) } });
    const fresh = view([alive], Date.parse(later(3_600_000)) + 10_000).section;
    expect(fresh).toContain(">owner alive<"); expect(fresh).toContain("Responsible: Owning test runner");
    expect(fresh).toContain("A live PID is an observation, not proof of the owner&#x27;s identity.");
    const stale = view([alive], Date.parse(later(3_600_000)) + 900_000).section;
    expect(stale).toContain(">unconfirmed<"); expect(stale).toContain("A stale live PID is not proof of a running job.");
    expect(stale).not.toContain(">owner alive<");
  });

  test("hosts and Android phones are separate rows; a shared fixture alias does not merge them; only published runs link", () => {
    const { section } = view([
      item("mini-2", noOwnerObservation("routine-9-1-dev-no-glasses"), { publishedRunIds: ["routine-9-1-dev-no-glasses"] }),
      item("mini-1", retainedObservation("run-a")),
      item("mini-1", aliveObservation("phone-run"), { resourceKey: "android-0123456789ab" }),
    ], Date.parse(later(3_600_000)) + 10_000);
    expect(section.match(/<tr class="border-t/g)).toHaveLength(3);
    // Attention first: the retained hold, then the live owner, then the no-owner snapshot.
    expect(section.indexOf("mini-1</p><p class=\"mt-1 text-[11px] text-[#68746d]\">Shared")).toBeLessThan(section.indexOf("Android phone 0123456789ab only"));
    expect(section.indexOf("Android phone 0123456789ab only; independent of the shared guard")).toBeLessThan(section.indexOf("mini-2"));
    expect(section.match(/Fixture 03BE:|Reserved fixture: 03BE/g)!.length).toBeGreaterThanOrEqual(3);
    expect(section.match(/<button/g)).toHaveLength(1);
    expect(section).toContain(">routine-9-1-dev-no-glasses</button>");
    expect(section).toContain("<strong>1</strong> retained hold"); expect(section).toContain("<strong>1</strong> owner alive");
  });

  test("unavailable guard states use fixed wording and operator next actions", () => {
    const unreadable = { state: "unknown", reason: "owner-unverifiable", guard: { lock: "unreadable", reclaimMarker: "absent" }, fixture: { checked: false } } as TestResourceObservation;
    const malformed = { state: "idle-prerequisite-unknown", reason: "fixture-record-malformed", guard: { lock: "absent", reclaimMarker: "absent" },
      fixture: { checked: true, record: "malformed" } } as TestResourceObservation;
    const { section } = view([item("mini-1", unreadable), item("mini-2", malformed)], Date.parse(later(3_600_000)));
    expect(section).toContain("Guard unreadable"); expect(section).toContain(">unknown<");
    expect(section).toContain("Only the owner&#x27;s recovery or the normal acquisition may change it.");
    expect(section).toContain("Fixture record malformed."); expect(section).toContain("Responsible: Operator");
    expect(section).toContain("Next: Recommission this fixture before routines use it.");
    expect(resourceStatus(item("mini-1", unreadable), Date.parse(later(3_600_000)) + 86_400_000).priority).toBe(1);
  });
});

describe("worker-reported activity on a GitHub-queued job", () => {
  // Sanitized DEV424 observation as Core now projects it.
  const observedAt = "2026-09-26T22:00:32.755Z";
  const receivedAt = "2026-09-26T22:00:29.084Z";
  const view = (reported: boolean): TestRunOverview => ({ observedAt, warnings: [], resolvedRecoveries: [], recentMaintenance: [], fixtureSummary: [], jobs: [{
    id: "github-36271748180", kind: "routine", state: reported ? "running" : "queued", title: "Device routine request 36271681505 / attempt 1",
    createdAt: "2026-09-26T21:05:41Z",
    requests: [{ requestId: "routine-36271681505-1-dev-no-glasses-android", requestRunId: 36271681505, requestAttempt: 1, routineId: "no-glasses-android",
      trigger: "successful-build", platform: "android", channel: "dev", release: "3.3.0-dev.424" }],
    claims: [{ requestId: "routine-36271681505-1-dev-no-glasses-android", workerId: "mentra-device-mini-1-android", fixtureId: "mini-samsung-a54",
      claimedAt: "2026-09-26T21:57:58.897Z", progress: { sequence: 44, mode: "running", phase: "test", receivedAt,
        step: { id: "walkthrough", label: "Replay the shared walkthrough" }, completedSteps: 0, totalSteps: 1,
        action: { id: "HOME-05-close", label: "Press Android Back once to close the all-miniapps sheet.", completedActions: 6, totalActions: 38 } } }],
    workflow: { runId: 36271748180, url: "https://github.com/Mentra-Community/Mentra-Automated-Testing/actions/runs/36271748180",
      status: "queued", updatedAt: "2026-09-26T21:05:41Z" },
    ...(reported ? { reportedActivity: { requestId: "routine-36271681505-1-dev-no-glasses-android", claimedAt: "2026-09-26T21:57:58.897Z", receivedAt } }
      : { attention: { reason: "GitHub has not started this job; runner availability has not been verified.", responsible: "GitHub / runner operator" as const,
        nextAction: "Check the GitHub job's required labels and the runner's status." } }),
  }] });
  const render = (value: TestRunOverview, now: number) => renderToStaticMarkup(<TestRunOverviewView data={value} now={now} onResult={() => {}} />);

  test("fresh worker progress is the primary running state, counted and timed from the worker claim; GitHub queued stays visible", () => {
    const html = render(view(true), Date.parse(observedAt));
    expect(html).toContain(">running</span>");
    expect(html).toContain("<strong>1</strong> running");
    expect(html).toContain("<strong>0</strong> queued");
    expect(html).toContain("Reported by the worker · GitHub status: queued");
    expect(html).toContain("6 of 38 actions completed");
    expect(html).toContain("2m 33s"); expect(html).toContain("Since worker claim");
    expect(html).not.toContain("GitHub has not started this job");
    const ciTable = html.slice(html.indexOf('aria-label="CI requests"'));
    expect(ciTable.slice(0, ciTable.indexOf("</table>"))).not.toContain(">Waiting<");
  });

  test("once the checkpoint ages past the bound between refreshes, the activity is unconfirmed rather than running", () => {
    const html = render(view(true), Date.parse(receivedAt) + 120_001);
    expect(html).toContain(">unknown</span>");
    expect(html).toContain("<strong>0</strong> running");
    expect(html).toContain("<strong>1</strong> unknown");
    expect(html).toContain("Worker checkpoint no longer recent; activity is unconfirmed · GitHub status: queued");
    expect(html).toContain("No recent checkpoint; activity is unconfirmed");
    // At the bound itself it is still running.
    expect(render(view(true), Date.parse(receivedAt) + 120_000)).toContain("<strong>1</strong> running");
  });

  test("a queued job without worker-reported activity keeps the waiting state and GitHub guidance", () => {
    const html = render(view(false), Date.parse(observedAt));
    expect(html).toContain(">queued</span>");
    expect(html).toContain("<strong>1</strong> queued");
    expect(html).toContain("GitHub has not started this job; runner availability has not been verified.");
    expect(html).toContain("Waiting");
    expect(html).not.toContain("Reported by the worker");
  });
});

describe("Core refresh and cached aging agree on stale worker activity", () => {
  // Real overview service responses (JSON round-tripped like the API), rendered by the Admin view.
  const requestId = "routine-36271681505-1-dev-no-glasses-android";
  const receivedAt = "2026-09-26T22:00:29.084Z", received = Date.parse(receivedAt);
  const claimed = { requestId, requestSha256: "a".repeat(64), workerId: "mentra-device-mini-1-android", fixtureId: "mini-samsung-a54",
    executionId: "execution-dev424", claimedAt: "2026-09-26T21:57:58.897Z", state: "claimed" as const };
  const progress = (mode: "running" | "recovering" = "running") => ({ sequence: 44, mode, phase: "test" as const, receivedAt,
    step: { id: "walkthrough", label: "Replay the shared walkthrough" }, completedSteps: 0, totalSteps: 1,
    action: { id: "HOME-05-close", label: "Press Android Back once to close the all-miniapps sheet.", completedActions: 6, totalActions: 38 } });
  const githubJob = (): OverviewJob => ({ id: "github-36271748180", kind: "routine", state: "queued", title: "Device routine request 36271681505 / attempt 1",
    createdAt: "2026-09-26T21:05:41Z", claims: [],
    requests: [{ requestId, requestRunId: 36271681505, requestAttempt: 1, routineId: "no-glasses-android", trigger: "successful-build",
      platform: "android", channel: "dev", release: "3.3.0-dev.424" }],
    workflow: { runId: 36271748180, url: "https://github.com/Mentra-Community/Mentra-Automated-Testing/actions/runs/36271748180",
      status: "queued", updatedAt: "2026-09-26T21:05:41Z" } });
  const repository = (rows: OverviewClaimRecord[]): TestRunOverviewRepository => ({
    claims: async () => ({ claims: rows, truncated: false }), latestFixtureClaims: async () => [], results: async () => [],
    adminRequests: async () => [], resourceObservations: async () => ({ rows: [], truncated: false }), publishedRunIds: async () => [] });
  const refresh = async (rows: OverviewClaimRecord[], at: number): Promise<TestRunOverview> => JSON.parse(JSON.stringify(
    await new TestRunOverviewService(repository(rows), { activity: async () => ({ jobs: [githubJob()], warnings: [] }) }, () => new Date(at)).overview()));
  const render = (value: TestRunOverview, now: number) => renderToStaticMarkup(<TestRunOverviewView data={value} now={now} onResult={() => {}} />);
  const statusCell = (html: string) => /<td class="px-4 py-3">[\s\S]*?<\/td>/.exec(html)![0];
  const counts = (html: string) => /<div class="mt-3 flex flex-wrap gap-2 text-xs">[\s\S]*?<\/div>/.exec(html)![0];
  const stale = received + 120_001;
  const neverStarted = "GitHub has not started this job";

  test("after 120 001 ms the refreshed Core response matches the aged cached view: unknown, unconfirmed, GitHub still queued", async () => {
    const rows = [{ claim: claimed, progress: progress() }];
    const fresh = await refresh(rows, received + 60_000);
    expect(render(fresh, received + 60_000)).toContain("Reported by the worker · GitHub status: queued");
    const cached = render(fresh, stale), refreshed = render(await refresh(rows, stale), stale);
    for (const html of [cached, refreshed]) {
      expect(html).toContain(">unknown</span>");
      expect(html).toContain("Worker checkpoint no longer recent; activity is unconfirmed · GitHub status: queued");
      expect(html).toContain("<strong>1</strong> unknown"); expect(html).toContain("<strong>0</strong> queued");
      expect(html).toContain("Since worker claim");
      expect(html).toContain("No recent checkpoint; activity is unconfirmed");
      expect(html).not.toContain(neverStarted);
    }
    expect(statusCell(refreshed)).toBe(statusCell(cached));
    expect(counts(refreshed)).toBe(counts(cached));
  });

  test("a queued job whose claim never reported keeps the queued state and GitHub guidance", async () => {
    const html = render(await refresh([{ claim: claimed }], stale), stale);
    expect(html).toContain(">queued</span>"); expect(html).toContain(neverStarted);
    expect(html).not.toContain("Reported by the worker"); expect(html).not.toContain("Worker checkpoint no longer recent");
  });

  test("blocked, closed and terminal claims with an old checkpoint are not shown as worker activity", async () => {
    const closure = { kind: "android-refused-install-released" as const, originalTerminal: { sequence: 26, sha256: "b".repeat(64) },
      journalPrefix: { bytes: 4096, sha256: "c".repeat(64) }, release: { type: "setup-abandoned-after-refusal" as const, sequence: 27,
        eventSha256: "d".repeat(64), revision: "1".repeat(40), implementationSha256: "e".repeat(64) }, fixture: "uncommissioned" as const,
      selectedCandidateInstalled: false as const, candidateTestRun: false as const, recordingStarted: false as const, closedAt: receivedAt };
    const blocked = render(await refresh([{ claim: { ...claimed, state: "recovery-required", settledAt: receivedAt,
      settlement: { state: "recovery-required", reason: "synthetic" } }, progress: progress("recovering") }], stale), stale);
    expect(blocked).toContain(">blocked</span>");
    const closed = render(await refresh([{ claim: claimed, progress: progress(), closure }], stale), stale);
    const terminal = render(await refresh([{ claim: { ...claimed, state: "terminal", settledAt: receivedAt,
      settlement: { state: "terminal", resultRunId: requestId } }, progress: progress() }], stale), stale);
    for (const html of [blocked, closed, terminal]) {
      expect(html).not.toContain("Reported by the worker");
      expect(html).not.toContain("Worker checkpoint no longer recent");
      expect(html).not.toContain(">unknown</span>");
      expect(html).not.toContain(">running</span>");
    }
  });
});

describe("shared guard glasses scope", () => {
  const run = "routine-2-1-staging-no-glasses", at = Date.parse("2026-09-27T20:00:00.000Z");
  /** Reports through the real Core service, then renders the real overview composition and Admin view. */
  const composed = async (reports: { hostId: string; resourceKey?: string; observation: TestResourceObservation }[]) => {
    const rows = new Map<string, StoredTestResourceObservation>();
    const service = new TestResourceObservationService({
      get: async (hostId, resourceKey) => structuredClone(rows.get(hostId + "/" + resourceKey) ?? null),
      insert: async value => { const key = value.hostId + "/" + value.resourceKey; if (rows.has(key)) return false; rows.set(key, structuredClone(value)); return true; },
      replace: async (revision, value) => { const key = value.hostId + "/" + value.resourceKey; if (rows.get(key)?.revision !== revision) return false; rows.set(key, structuredClone(value)); return true; },
    }, () => new Date(at));
    for (const { hostId, resourceKey = "shared", observation } of reports)
      await service.put(hostId, resourceKey, { schemaVersion: 1, hostId, resourceKey, expectedRevision: 0, observation });
    const overview: TestRunOverview = JSON.parse(JSON.stringify(await new TestRunOverviewService({
      claims: async () => ({ claims: [], truncated: false }), latestFixtureClaims: async () => [], results: async () => [], adminRequests: async () => [],
      resourceObservations: async () => ({ rows: [...rows.values()], truncated: false }), publishedRunIds: async () => [],
    }, { activity: async () => ({ jobs: [], warnings: [] }) }, () => new Date(at + 10_000)).overview()));
    const html = renderToStaticMarkup(<TestRunOverviewView data={overview} now={at + 10_000} onResult={() => {}} />);
    const start = html.indexOf('aria-label="Local resource observations"');
    const section = html.slice(start, html.indexOf("</section>", start));
    const row = (hostId: string) => {
      const host = section.indexOf(">" + hostId + "</p>");
      return section.slice(section.lastIndexOf("<tr", host), section.indexOf("</tr>", host));
    };
    return { overview, section, row };
  };

  test("a retained verified-none owner is shown distinctly, still as a retained hold whose recovery remains required", async () => {
    const { overview, row } = await composed([
      { hostId: "mini-none", observation: retainedObservation(run, 4242, "none") },
      { hostId: "mini-legacy", observation: retainedObservation(run, 4343) },
    ]);
    expect(overview.resourceObservations!.items.map(item => [item.hostId, item.observation.owner?.valid && item.observation.owner.glassesScope]))
      .toEqual([["mini-legacy", undefined], ["mini-none", "none"]]);
    const none = row("mini-none"), legacy = row("mini-legacy");
    expect(none).toContain("Reported glasses scope (at this observation): verified none. This guard does not exclude other glasses pairs; each still needs its own lease. Mac UI, audio and recorder custody stay with this owner.");
    // The scope never turns the hold into readiness, a release or completed recovery.
    expect(none).toContain(">retained hold<"); expect(none).toContain("A dead PID or completed checkpoint does not release this hold.");
    expect(none).toContain("Next: Resume this run&#x27;s recovery through its original owner and publish verified return evidence.");
    expect(none).not.toMatch(/>ready<|released|recovered|available to|free to use|pair is free/i);
    // An older host's report without the field is unknown, never none.
    expect(legacy).toContain("Glasses scope not reported by this host: treated as unknown, so every glasses pair is excluded.");
    expect(legacy).not.toContain("verified none");
  });

  test("identified, unknown and invalid owners, and phone guards, keep their own honest wording", async () => {
    const invalid = { state: "unknown", reason: "owner-unverifiable", guard: { lock: "present", reclaimMarker: "absent" }, owner: { valid: false },
      fixture: { checked: false } } as TestResourceObservation;
    const { row, section } = await composed([
      { hostId: "mini-identified", observation: aliveObservation(run, 5000, "identified") },
      { hostId: "mini-unknown", observation: aliveObservation(run, 5001, "unknown") },
      { hostId: "mini-invalid", observation: invalid },
      { hostId: "mini-phone", resourceKey: "android-0123456789ab", observation: aliveObservation("phone-run", 5002) },
      { hostId: "mini-idle", observation: noOwnerObservation() },
    ]);
    expect(row("mini-identified")).toContain("Reported glasses scope (at this observation): one identified pair, held by its own lease. Other pairs still need their own leases.");
    expect(row("mini-unknown")).toContain("Reported glasses scope (at this observation): unknown, so every glasses pair is excluded.");
    expect(row("mini-invalid")).toContain("Owner record invalid"); expect(row("mini-invalid")).toContain("Glasses scope unknown: every glasses pair is excluded.");
    // A phone-only guard never shows a glasses scope, and an absent guard has no owner scope to report.
    expect(row("mini-phone")).toContain("Android phone 0123456789ab only; independent of the shared guard");
    expect(row("mini-phone")).not.toContain("Glasses scope"); expect(row("mini-idle")).not.toContain("Glasses scope");
    expect(section.match(/Reported glasses scope|Glasses scope unknown|Glasses scope not reported/g)).toHaveLength(3);
  });

  test("a stale verified-none observation stays bound to that observation: still a retained hold or an unconfirmed owner", async () => {
    const { section } = await composed([
      { hostId: "mini-retained", observation: retainedObservation(run, 4242, "none") },
      { hostId: "mini-live", observation: aliveObservation("run-live", 5000, "none") },
    ]);
    // Re-render the same Core overview a day later: the observation is no longer current.
    const stale = renderToStaticMarkup(<TestRunOverviewView data={JSON.parse(JSON.stringify((await composed([
      { hostId: "mini-retained", observation: retainedObservation(run, 4242, "none") },
      { hostId: "mini-live", observation: aliveObservation("run-live", 5000, "none") },
    ])).overview))} now={at + 86_400_000} onResult={() => {}} />);
    expect(section).toContain(">owner alive<");
    const resources = stale.slice(stale.indexOf('aria-label="Local resource observations"'));
    const row = (hostId: string) => { const host = resources.indexOf(">" + hostId + "</p>"); return resources.slice(resources.lastIndexOf("<tr", host), resources.indexOf("</tr>", host)); };
    expect(row("mini-retained")).toContain(">retained hold<"); expect(row("mini-retained")).toContain("Kept until this host reports a newer observation");
    expect(row("mini-live")).toContain(">unconfirmed<"); expect(row("mini-live")).toContain("Not current");
    for (const host of ["mini-retained", "mini-live"]) {
      expect(row(host)).toContain("Reported glasses scope (at this observation): verified none.");
      expect(row(host)).not.toMatch(/>ready<|released|recovered|available to|free to use|>owner alive</i);
    }
  });
});
