/** Source-only API fixture: no application archive, token or device access. */
import {requestInputDigest} from "./routine-api.mjs"
export function routineFixture({routineId = "example.screen-check", platform = "ios-on-mac", channel = "pr"} = {}) {
  const definition = {id: routineId, title: "Example screen check", platforms: [platform], steps: [{id: "example-step"}], execution: {resourceKinds: ["app", "recorder"]}}
  const enrollment = {routineId, platform, definitionRevision: "b".repeat(40), definition}
  const source = {channel, buildRunId: 10, publicationAttempt: 2, ...(channel === "pr" ? {prNumber: 12} : {})}
  const build = {repository: "Mentra-Community/MentraOS", headSha: "a".repeat(40), channel, source,
    ...(channel === "pr" ? {prNumber: 12} : {releaseIdentity: `3.3.0-${channel === "dev" ? "dev" : "beta"}.1`}), archive: {sha256: "c".repeat(64)}}
  const request = {requestId: "example-request", hostId: "example-host", state: "accepted", input: {routineId,
    platform, definitionRevision: enrollment.definitionRevision, laneId: "example-lane", build}}
  request.inputSha256 = requestInputDigest(request.input)
  request.dispatchIntent = {requestId: request.requestId, routineId, platform, routineRevision: enrollment.definitionRevision,
    laneId: request.input.laneId, source, build: structuredClone(build)}
  request.dispatchIntentSha256 = requestInputDigest(request.dispatchIntent)
  const run = {requestId: request.requestId, hostId: request.hostId, routineId, platform, definitionRevision: enrollment.definitionRevision,
    laneId: request.input.laneId, build: structuredClone(build), finishedAt: "2026-10-03T12:01:00.000Z",
    result: {runId: request.requestId, test: "passed", setup: {status: "passed"}, steps: [{id: "example-step", status: "passed"}], teardown: {ready: true}}}
  const detail = {request, result: {run, definition, outcome: "pass", uploadsComplete: true, evidenceStatus: "complete"}}
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({url, options})
    if (new URL(url).pathname.endsWith("/routine-catalog")) return Response.json({routineRevision: enrollment.definitionRevision,
      routines: [{routineId, ...(new URL(url).searchParams.has('routines') ? {platforms: definition.platforms} : {})}]})
    if (options.method === "POST") {
      const submitted = JSON.parse(options.body)
      const intent = {...request.dispatchIntent, requestId: submitted.requestId, routineId: submitted.routineId,
        platform: submitted.platform, routineRevision: submitted.routineRevision ?? enrollment.definitionRevision,
        source: submitted.source, build: {...build, source: submitted.source}}
      return Response.json({requestId: submitted.requestId, hostId: request.hostId, state: "preparing", dispatchIntent: intent,
        dispatchIntentSha256: requestInputDigest(intent)})
    }
    return Response.json(detail)
  }
  return {definition, enrollment, source, build, request, run, detail, fetchImpl, calls}
}

export function preparingRoutineFixture({status, ...options} = {}) {
  const fixture = routineFixture(options), {request} = fixture
  delete request.input; delete request.inputSha256
  request.state = status ? "terminal" : "preparing"
  fixture.detail.result = null
  if (status === "cancelled") {
    request.terminalStatus = "cancelled"
    request.preparationCancellation = {requestedAt: "2026-10-03T12:01:00.000Z", reason: "Cancelled before source preparation"}
  } else if (status) {
    request.terminalStatus = "not-run"
    request.preparationRejection = {dispatchIntentSha256: request.dispatchIntentSha256, code: status === "skipped" ? "unsupported-platform" : "invalid-definition",
      reason: status === "skipped" ? "The routine does not support this platform" : "Source description failed",
      rejectedAt: "2026-10-03T12:01:00.000Z", disposition: status === "skipped" ? "not-applicable" : "not-run"}
  }
  return fixture
}

export function terminalRoutineFixture({status = "not-run", ...options} = {}) {
  const fixture = routineFixture(options), {request} = fixture
  request.state = "terminal"; request.terminalStatus = status
  const receipt = {requestId: request.requestId, hostId: request.hostId, inputSha256: request.inputSha256,
    reason: status === "not-run" ? "Installed host cannot execute this definition" : "Request cancelled before admission"}
  if (status === "not-run") request.hostRejection = {...receipt, rejectedAt: "2026-10-03T12:01:00.000Z", code: "missing-definition"}
  else request.hostCancellation = {...receipt, requestedAt: "2026-10-03T12:01:00.000Z"}
  fixture.detail.result = null
  return fixture
}

export function portableRoutineFixture({status, state = "awaiting-source", ...options} = {}) {
  const fixture = routineFixture(options), {request, build} = fixture
  const selection = {...request.dispatchIntent, build: {...build, kind: request.input.platform === "android" ? "android-apk" : "mac-ci-package"}}
  delete selection.laneId
  delete request.hostId; delete request.input; delete request.inputSha256
  delete request.dispatchIntent; delete request.dispatchIntentSha256
  request.fleetSelection = selection; request.fleetSelectionSha256 = requestInputDigest(selection)
  request.state = status ? "terminal" : state
  fixture.detail.result = null
  if (status) {
    request.terminalStatus = "not-run"
    request.fleetCancellation = {requestedAt: "2026-10-03T12:01:00.000Z", reason: "Suite deadline expired while awaiting a compatible lane"}
  }
  return fixture
}
