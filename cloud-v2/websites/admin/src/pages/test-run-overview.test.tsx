import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { aliveObservation, noOwnerObservation, resourceProgress, retainedObservation } from "../../../../packages/core/src/types/test-resource-observation.examples";
import type { TestResourceObservation } from "../../../../packages/core/src/types/test-resource-observation.types";
import type { OverviewJob, OverviewResourceObservation, TestRunOverview } from "../../../../packages/core/src/types/test-run-overview.types";
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
    expect(section).toContain("Shared guard: Mac UI, Mac audio and all glasses pairs");
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
