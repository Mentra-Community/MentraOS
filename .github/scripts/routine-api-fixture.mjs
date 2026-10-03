/** Source-only API fixture: no application archive, token or device access. */
export function routineFixture({routineId = "example.screen-check", platform = "ios-on-mac", channel = "pr"} = {}) {
  const definition = {id: routineId, title: "Example screen check", platforms: [platform], steps: [{id: "example-step"}], execution: {resourceKinds: ["app", "recorder"]}}
  const enrollment = {routineId, platform, definitionRevision: "b".repeat(40), definition}
  const source = {channel, buildRunId: 10, publicationAttempt: 2, ...(channel === "pr" ? {prNumber: 12} : {})}
  const build = {repository: "Mentra-Community/MentraOS", headSha: "a".repeat(40), channel, source,
    ...(channel === "pr" ? {prNumber: 12} : {releaseIdentity: `3.3.0-${channel === "dev" ? "dev" : "beta"}.1`}), archive: {sha256: "c".repeat(64)}}
  const request = {requestId: "example-request", hostId: "example-host", state: "accepted", input: {routineId,
    platform, definitionRevision: enrollment.definitionRevision, laneId: "example-lane", build}}
  const run = {requestId: request.requestId, hostId: request.hostId, routineId, platform, definitionRevision: enrollment.definitionRevision,
    laneId: request.input.laneId, build: structuredClone(build), finishedAt: "2026-10-03T12:01:00.000Z",
    result: {runId: request.requestId, test: "passed", setup: {status: "passed"}, steps: [{id: "example-step", status: "passed"}], teardown: {ready: true}}}
  const detail = {request, result: {run, definition, outcome: "pass", uploadsComplete: true, evidenceStatus: "complete"}}
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({url, options})
    if (url.endsWith("/routine-catalog")) return Response.json({routines: [enrollment]})
    if (options.method === "POST") {
      const submitted = JSON.parse(options.body)
      return Response.json({...request, requestId: submitted.requestId, input: {...request.input, routineId: submitted.routineId,
        platform: submitted.platform, build: {...build, source: submitted.source}}})
    }
    return Response.json(detail)
  }
  return {definition, enrollment, source, build, request, run, detail, fetchImpl, calls}
}
