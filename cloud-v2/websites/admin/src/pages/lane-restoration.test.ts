import {expect, test} from "bun:test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import type {LaneRestorationAttempt, LaneRestorationHost} from "../../../../packages/core/src/types/lane-restoration.types";
import {restorationElapsed, restorationOutcome, RestorationHost} from "./lane-restoration";
const at = "2026-10-05T01:00:00Z";
const attempt: LaneRestorationAttempt = {executionId: "fixer:first", interruptionId: "repair:mac:1", laneId: "mac", generation: 1,
  current: true, state: "stopped", assignedAt: at, handedOffAt: at, startedAt: at, finishedAt: "2026-10-05T01:02:03Z",
  report: {reportId: "report:first", reportedAt: at, decision: "resume", summary: "Readiness observed", question: null},
  resume: {status: "unknown", decisionId: null, calledAt: null, reason: null}, requiredAction: null, actions: [], actionsTruncated: false,
  requestId: "nightly:first", runId: null, incidentId: null, sessionId: null};
const host: LaneRestorationHost = {hostId: "mini", receivedAt: at, observedAt: at,
  lanes: [{id: "mac", platform: "ios-on-mac", state: "in-repair", dispatchMode: "automatic"}],
  restoration: {schemaVersion: 1, attempts: [attempt], truncated: false}};
const render = (value = host, fresh = true) => renderToStaticMarkup(createElement(RestorationHost, {host: value, fresh}));
test("a resume intention and stopped agent do not become successful scheduling", () => {
  const markup = render();
  expect(markup).toContain("Stopped before resumption"); expect(markup).toContain("intention to resume");
  expect(markup).toContain("Resume call and acceptance: unknown"); expect(markup).not.toContain("Scheduling resumed");
  expect(markup).toContain("2m 3s"); expect(markup).toContain("testRun=nightly%3Afirst");
});
test("accepted receipt, refusal and human question stay separate", () => {
  const resumed = {...attempt, state: "resumed" as const, resume: {status: "accepted" as const, decisionId: "resume:one", calledAt: at, reason: null}};
  expect(restorationOutcome(resumed)).toBe("Scheduling resumed");
  expect(render({...host, restoration: {...host.restoration!, attempts: [resumed]}})).toContain("called and accepted");
  const needsInput = {...attempt, state: "needs-input" as const, report: {...attempt.report!, decision: "needs-input" as const, question: "Please connect the charger"},
    resume: {status: "refused" as const, decisionId: "resume:no", calledAt: at, reason: "Writer remains active"}};
  const markup = render({...host, restoration: {...host.restoration!, attempts: [needsInput]}});
  expect(markup).toContain("Needs human input"); expect(markup).toContain("Please connect the charger");
  expect(markup).toContain("called and refused"); expect(markup).toContain("Writer remains active");
});
test("missing records, stale host and unfinished durations remain honest", () => {
  expect(render({...host, restoration: null})).toContain("has not reported restoration records");
  expect(render(host, false)).toContain("Current controller state unknown");
  expect(render(host, false)).toContain("last reported in repair");
  expect(restorationElapsed({...attempt, startedAt: null, assignedAt: null}, at)).toBe("Duration unknown");
  expect(restorationElapsed({...attempt, finishedAt: null}, "2026-10-05T01:03:00Z")).toBe("3m 0s at last observation");
});
