import {expect, test} from "bun:test";
import {NIGHTLY_COMPLETION_BOUNDARY_REASON, nightlyUnassignedReason} from "./nightly-deadline-reason";
import {NightlyRoutineService, type NightlyPlan, type NightlyResult} from "./nightly-routine.service";
import {nightlySuiteProjection, terminalNightlySummary} from "./test-suite.service";
import {requestInputDigest} from "./test-request.service";
import {testSuiteSchema} from "../types/test-suite.types";

const startedAt = "2026-10-09T11:00:00Z", finishedAt = "2026-10-09T14:00:09Z";
const explained = "Nightly deadline expired before a compatible lane and required resources were assigned.";
function frozenOccurrence() {
  const build = {repository: "Mentra-Community/MentraOS" as const, headSha: "a".repeat(40), channel: "dev" as const,
    kind: "mac-ci-package" as const, source: {channel: "dev" as const, buildRunId: 21, publicationAttempt: 1},
    archive: {name: "app.zip", url: "https://artifactscdn.mentraglass.com/app.zip", size: 100, sha256: "c".repeat(64)},
    receipt: {url: "https://artifactscdn.mentraglass.com/receipt.json", size: 10, sha256: "d".repeat(64)}};
  const suite = testSuiteSchema.parse({suiteId: "nightly-expired", channel: "dev", trigger: "nightly", startedAt,
    build: {headSha: build.headSha}, members: ["account-google", "captions-phone"].map(routineId =>
      ({memberId: routineId, requestId: routineId, routineId, platform: "ios-on-mac"}))});
  const members = suite.members.map(member => ({...member, requestId: member.requestId!, platform: "ios-on-mac" as const,
    definitionRevision: "b".repeat(40), routineRevision: "b".repeat(40), build,
    selection: {requestId: member.requestId!, routineId: member.routineId, platform: "ios-on-mac" as const,
      routineRevision: "b".repeat(40), source: build.source, build}}));
  const plan: NightlyPlan = {suiteId: suite.suiteId, occurrenceId: "original-occurrence", startedAt, trigger: "nightly", suite, members};
  const result: NightlyResult = {...plan, expectedCount: 2, passed: 0, status: "incomplete", finishedAt,
    members: members.map(member => ({...member, status: "incomplete", publicationComplete: false,
      unavailableReason: NIGHTLY_COMPLETION_BOUNDARY_REASON}))};
  return {suite, plan, result};
}

test("expired unassigned nightly detail and compact history explain the frozen boundary without new evidence", () => {
  const {suite, plan, result} = frozenOccurrence(), original = requestInputDigest({plan, result});
  const compact = (value: typeof plan | typeof result) => ({...value, members: value.members.map(member => ({...member, portable: true}))});
  for (const projection of [nightlySuiteProjection(suite, plan, result), terminalNightlySummary(suite, compact(plan), compact(result))]) {
    expect(projection).toMatchObject({outcome: "failed", passed: 0, members: [
      {status: "not-run", publicationComplete: false, unavailableReason: explained},
      {status: "not-run", publicationComplete: false, unavailableReason: explained}]});
    expect(projection.members.every(member => !member.runId && !member.hostId && !member.laneId)).toBe(true);
  }
  expect(requestInputDigest({plan, result})).toBe(original);
});

test("deadline snapshot retains only the saved waiting reason and keeps it across frozen restart", async () => {
  const {suite, plan, result} = frozenOccurrence();
  const requests = plan.members.map((member, index) => ({requestId: member.requestId, state: "terminal" as const,
    fleetSelection: member.selection!, fleetSelectionSha256: requestInputDigest(member.selection),
    fleetDeadline: new Date(finishedAt), fleetCancellation: {requestedAt: finishedAt, reason: NIGHTLY_COMPLETION_BOUNDARY_REASON},
    ...(index === 0 ? {preparation: {code: "unavailable-provider", reason: "Recorded fixture service was unavailable", observedAt: startedAt},
      fleetDispatch: {error: "Less specific dispatch failure"}} : {})}));
  const original = JSON.stringify(requests);
  const service = new NightlyRoutineService(undefined, undefined, {async get(id) {return requests.find(row => row.requestId === id) as any;}});
  const snapshot = await service.snapshot(plan);
  expect(snapshot.members[0]!.unavailableReason).toBe(`${explained} Last recorded waiting reason: Recorded fixture service was unavailable`);
  expect(snapshot.members[1]!.unavailableReason).toBe(explained);
  const frozen = {...snapshot, finishedAt: result.finishedAt};
  expect(nightlySuiteProjection(suite, plan, structuredClone(frozen)).members[0]!.unavailableReason).toBe(snapshot.members[0]!.unavailableReason);
  expect(JSON.stringify(requests)).toBe(original);
});

test("explicit cancellation, bound members, early completion and unrelated reasons are preserved", () => {
  const input = {reason: NIGHTLY_COMPLETION_BOUNDARY_REASON, startedAt, observedAt: finishedAt, unassigned: true};
  for (const changed of [{unassigned: false}, {observedAt: "2026-10-09T12:00:00Z"}, {observedAt: undefined},
    {observedAt: "invalid"}, {reason: "Operator cancelled this suite"}, {reason: "Awaiting exact source"}]) {
    expect(nightlyUnassignedReason({...input, ...changed})).toBe(changed.reason ?? input.reason);
  }
  expect(nightlyUnassignedReason({...input, recordedWaitingReason: "x".repeat(4000)})!.length).toBe(2000);
  const {suite, plan, result} = frozenOccurrence();
  result.members[0]!.unavailableReason = "Operator cancelled this suite";
  result.finishedAt = "2026-10-09T12:00:00Z";
  expect(nightlySuiteProjection(suite, plan, result).members.map(member => member.unavailableReason)).toEqual([
    "Operator cancelled this suite", NIGHTLY_COMPLETION_BOUNDARY_REASON]);
});
