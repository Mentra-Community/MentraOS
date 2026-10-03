import {createHash} from "node:crypto"
import {isDeepStrictEqual} from "node:util"

const ENDPOINT = "https://core.dev.us-west-2.mentraglass.com/api/internal"
export const routineId = value => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(value ?? "")
export const requestIdentity = value => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/.test(value ?? "")
export const ensure = (condition, message) => {if (!condition) throw new Error(message)}
export const positive = value => Number.isSafeInteger(value) && value > 0
export const platforms = Object.freeze(["android", "ios-on-mac"])

export function routineLabelIds(pr) {
  return [...new Set((pr.labels ?? []).map(label => typeof label === "string" ? label : label.name)
    .filter(label => typeof label === "string" && label.startsWith("routine:")).map(label => label.slice(8)))].sort()
}

/** Identities and supported platforms come exclusively from current enrolled definitions. */
export function selectedCatalog(catalog, ids, platform) {
  ensure(Array.isArray(catalog?.routines), "Core routine catalog is unavailable")
  const rows = catalog.routines.map(row => {
    ensure(routineId(row.routineId) && platforms.includes(row.platform) && /^[a-f0-9]{40}$/.test(row.definitionRevision ?? "") &&
      row.definition?.id === row.routineId && typeof row.definition.title === "string" && row.definition.title.length > 0 &&
      row.definition.execution && row.definition.platforms?.includes(row.platform), "Core returned an invalid enrolled routine")
    return {routineId: row.routineId, title: row.definition.title, platform: row.platform, definitionRevision: row.definitionRevision}
  })
  ensure(new Set(rows.map(row => `${row.routineId}:${row.platform}`)).size === rows.length, "Core catalog contains ambiguous routine/platform entries")
  if (platform !== undefined) ensure(platforms.includes(platform), "Unsupported requested platform")
  if (ids !== undefined) for (const id of ids) ensure(routineId(id) && rows.some(row => row.routineId === id && (!platform || row.platform === platform)),
    `Routine ${id} is not enrolled${platform ? ` for ${platform}` : ""}`)
  return rows.filter(row => (!ids || ids.includes(row.routineId)) && (!platform || row.platform === platform))
}

export function exactSource(source) {
  ensure(source && ["pr", "dev", "staging"].includes(source.channel) && positive(source.buildRunId) && positive(source.publicationAttempt) &&
    (source.channel === "pr" ? positive(source.prNumber) : source.prNumber === undefined), "An exact published build source is required")
  return {channel: source.channel, buildRunId: source.buildRunId, publicationAttempt: source.publicationAttempt,
    ...(source.channel === "pr" ? {prNumber: source.prNumber} : {})}
}

export function stableRequestId({occurrenceId, routineId: id, platform, source}) {
  ensure(requestIdentity(occurrenceId) && routineId(id) && platforms.includes(platform), "Invalid routine request identity")
  const sha256 = createHash("sha256").update(JSON.stringify([occurrenceId, id, platform, exactSource(source)])).digest("hex")
  return `routine-${sha256}`
}

export async function routineApi({token, operation, request, requestId = request?.requestId, fetchImpl = fetch}) {
  ensure(token && ["catalog", "dispatch", "detail"].includes(operation), "Routine API capability is missing")
  if (operation !== "catalog") ensure(requestIdentity(requestId), "Invalid routine request identity")
  if (operation === "dispatch") ensure(routineId(request?.routineId) && platforms.includes(request.platform) && exactSource(request.source), "Invalid routine dispatch")
  const path = operation === "catalog" ? "/routine-catalog" : `/routine-dispatches${operation === "detail" ? `/${encodeURIComponent(requestId)}` : ""}`
  let response
  try {response = await fetchImpl(`${ENDPOINT}${path}`, {method: operation === "dispatch" ? "POST" : "GET", redirect: "error",
    signal: AbortSignal.timeout(30_000), headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
    ...(operation === "dispatch" ? {body: JSON.stringify(request)} : {})})}
  catch {const error = new Error(`Routine API ${operation} response is unavailable`); error.retryable = true; throw error}
  if (!response.ok) {
    let message; try {message = (await response.json()).message} catch {}
    const error = new Error(`Routine API ${operation} failed (${response.status})${typeof message === "string" ? `: ${message.slice(0, 500)}` : ""}`)
    error.retryable = response.status >= 500 || response.status === 429
    throw error
  }
  const result = await response.json()
  if (operation === "catalog") {selectedCatalog(result); return result}
  const acknowledged = operation === "dispatch" ? result : result.request
  ensure(acknowledged?.requestId === requestId && routineId(acknowledged.input?.routineId) && platforms.includes(acknowledged.input.platform),
    "Routine API acknowledgement differs from its request")
  if (operation === "dispatch") ensure(acknowledged.input.routineId === request.routineId && acknowledged.input.platform === request.platform &&
    isDeepStrictEqual(acknowledged.input.build?.source, exactSource(request.source)), "Routine API changed the original routine or source")
  return result
}

/** Refuse a report whose request, source, host or frozen definition is inconsistent. */
export function boundRoutineResult(detail) {
  const {request, result} = detail ?? {}, run = result?.run, input = request?.input
  ensure(requestIdentity(request?.requestId) && input, "Missing accepted routine request")
  if (!result) return null
  ensure(run?.requestId === request.requestId && run.result?.runId === request.requestId && run.hostId === request.hostId &&
    run.routineId === input.routineId && run.platform === input.platform && run.definitionRevision === input.definitionRevision &&
    run.laneId === input.laneId && isDeepStrictEqual(run.build, input.build) && result.definition?.id === run.routineId &&
    typeof result.definition.title === "string" && Number.isFinite(Date.parse(run.finishedAt)) &&
    result.definition.platforms?.includes(run.platform) && Array.isArray(run.result?.steps) &&
    Array.isArray(result.definition.steps) && run.result.steps.length === result.definition.steps.length &&
    run.result.steps.every((step, index) => step.id === result.definition.steps[index].id) &&
    ["pass", "failed", "setup-failed", "teardown-failed", "not-run", "cancelled"].includes(result.outcome) &&
    typeof result.uploadsComplete === "boolean" && ["complete", "failed"].includes(result.evidenceStatus), "Result differs from its accepted request or definition")
  ensure(result.outcome !== "pass" || run.result.test === "passed" && run.result.setup?.status === "passed" &&
    run.result.teardown?.ready === true && run.result.steps.length > 0 && run.result.steps.every(step => step.status === "passed"),
    "Passing result contradicts its framework lifecycle")
  const passed = result.outcome === "pass" && result.uploadsComplete && result.evidenceStatus === "complete"
  return {routineId: run.routineId, title: result.definition.title, platform: run.platform, requestId: request.requestId,
    resultRunId: run.result.runId, finishedAt: run.finishedAt, source: exactSource(run.build.source),
    status: !result.uploadsComplete ? "upload-incomplete" : passed ? "passed" : result.outcome === "pass" ? "failed" : result.outcome}
}

export async function waitForRoutineResult({token, requestId, fetchImpl = fetch, now = Date.now,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), timeoutMilliseconds = 3 * 3600_000}) {
  ensure(timeoutMilliseconds > 0 && timeoutMilliseconds <= 3 * 3600_000, "Invalid routine result wait")
  const deadline = now() + timeoutMilliseconds
  for (;;) {
    let detail
    try {detail = await routineApi({token, operation: "detail", requestId, fetchImpl})}
    catch (error) {if (!error.retryable) throw error}
    if (detail) {
      const row = boundRoutineResult(detail)
      if (row && (detail.result.uploadsComplete || now() >= deadline)) return detail
      if (now() >= deadline) throw new Error(`No published routine result for ${requestId}; inspect Core request state`)
    }
    ensure(now() < deadline, `Routine result API did not recover for ${requestId}`)
    await sleep(Math.min(30_000, deadline - now()))
  }
}
