import {createHash} from "node:crypto"
import {isDeepStrictEqual} from "node:util"

const ENDPOINT = "https://core.dev.us-west-2.mentraglass.com/api/internal"
export const routineId = value => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(value ?? "")
export const requestIdentity = value => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/.test(value ?? "")
export const ensure = (condition, message) => {if (!condition) throw new Error(message)}
export const positive = value => Number.isSafeInteger(value) && value > 0
export const platforms = Object.freeze(["android", "ios-on-mac"])
export const routineRevision = value => /^[a-f0-9]{40}$/.test(value ?? "")

/** Match Core's finite-JSON input identity, independent of transport key order. */
export function requestInputDigest(input) {
  const canonical = value => {
    if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number" && Number.isFinite(value)) return value
    if (Array.isArray(value)) return value.map(canonical)
    if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    throw new Error("Request input must be finite JSON")
  }
  return createHash("sha256").update(JSON.stringify(canonical(input))).digest("hex")
}

/** A terminal request is a receipt, not evidence that a framework run existed. */
function terminalRequestResult(request) {
  if (request.state !== "terminal" || !["not-run", "cancelled"].includes(request.terminalStatus)) return null
  if (request.fleetSelection && !request.fleetBinding) {
    const selection = portableSelection(request), receipt = request.fleetCancellation
    ensure(request.terminalStatus === "not-run" && !request.hostId && !request.input && !request.inputSha256 &&
      !request.hostReceipt && !request.hostCancellation && !request.hostRejection &&
      receipt && Object.keys(receipt).length === 2 && Object.hasOwn(receipt, "requestedAt") && Object.hasOwn(receipt, "reason") &&
      typeof receipt.reason === "string" && receipt.reason.length > 0 && receipt.reason.length <= 2000 &&
      typeof receipt.requestedAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(receipt.requestedAt) && Number.isFinite(Date.parse(receipt.requestedAt)),
      "Terminal portable request differs from its immutable receipt")
    return {routineId: selection.routineId, title: selection.routineId, platform: selection.platform, requestId: request.requestId,
      finishedAt: receipt.requestedAt, source: exactSource(selection.source), status: "not-run", reason: receipt.reason}
  }
  if (!request.input) {
    const intent = boundDispatchIntent(request), cancelled = request.terminalStatus === "cancelled"
    const receipt = cancelled ? request.preparationCancellation : request.preparationRejection
    const keys = cancelled ? ["requestedAt", "reason"] : ["dispatchIntentSha256", "code", "reason", "rejectedAt", "disposition"]
    const timeKey = cancelled ? "requestedAt" : "rejectedAt"
    ensure(!request.inputSha256 && !request.hostReceipt && !request.hostCancellation && !request.hostRejection &&
      receipt && Object.keys(receipt).length === keys.length && keys.every(key => Object.hasOwn(receipt, key)) &&
      typeof receipt.reason === "string" && receipt.reason.length > 0 && receipt.reason.length <= 2000 &&
      typeof receipt[timeKey] === "string" && /^\d{4}-\d{2}-\d{2}T/.test(receipt[timeKey]) && Number.isFinite(Date.parse(receipt[timeKey])) &&
      (cancelled ? !request.preparationRejection : !request.preparationCancellation && receipt.dispatchIntentSha256 === request.dispatchIntentSha256 &&
        requestIdentity(receipt.code) && ["not-run", "not-applicable"].includes(receipt.disposition)),
      "Terminal preparation differs from its immutable receipt")
    return {routineId: intent.routineId, title: intent.routineId, platform: intent.platform, requestId: request.requestId,
      finishedAt: receipt[timeKey], source: exactSource(intent.source),
      status: receipt.disposition === "not-applicable" ? "skipped" : request.terminalStatus, reason: receipt.reason}
  }
  const cancelled = request.terminalStatus === "cancelled", receipt = cancelled ? request.hostCancellation : request.hostRejection
  const timeKey = cancelled ? "requestedAt" : "rejectedAt", keys = ["requestId", "hostId", "inputSha256", timeKey, "reason", ...(!cancelled ? ["code"] : [])]
  const input = request.input
  ensure(requestIdentity(request.hostId) && routineId(input.routineId) && platforms.includes(input.platform) &&
    /^[a-f0-9]{40}$/.test(input.definitionRevision ?? "") && requestIdentity(input.laneId) &&
    /^[a-f0-9]{64}$/.test(request.inputSha256 ?? "") && requestInputDigest(input) === request.inputSha256 &&
    receipt && Object.keys(receipt).length === keys.length && keys.every(key => Object.hasOwn(receipt, key)) &&
    receipt.requestId === request.requestId && receipt.hostId === request.hostId && receipt.inputSha256 === request.inputSha256 &&
    typeof receipt.reason === "string" && receipt.reason.length > 0 && receipt.reason.length <= 2000 &&
    typeof receipt[timeKey] === "string" && /^\d{4}-\d{2}-\d{2}T/.test(receipt[timeKey]) && Number.isFinite(Date.parse(receipt[timeKey])) &&
    (cancelled ? !request.hostRejection : !request.hostReceipt && !request.hostCancellation && requestIdentity(receipt.code)),
    "Terminal request differs from its immutable receipt")
  return {routineId: input.routineId, title: input.routineId, platform: input.platform, requestId: request.requestId,
    finishedAt: receipt[timeKey], source: exactSource(input.build?.source), status: request.terminalStatus, reason: receipt.reason}
}

export function routineLabelIds(pr) {
  return [...new Set((pr.labels ?? []).map(label => typeof label === "string" ? label : label.name)
    .filter(label => typeof label === "string" && label.startsWith("routine:")).map(label => label.slice(8)))].sort()
}

/** Discovery lists IDs at main; platform support is checked from that source on the host. */
export function selectedCatalog(catalog) {
  ensure(routineRevision(catalog?.routineRevision) && Array.isArray(catalog.routines), "Core routine catalog is unavailable")
  const rows = catalog.routines.map(row => {
    ensure(routineId(row.routineId), "Core returned an invalid routine identity")
    return {routineId: row.routineId, routineRevision: catalog.routineRevision}
  })
  ensure(new Set(rows.map(row => row.routineId)).size === rows.length, "Core catalog contains ambiguous routine identities")
  return rows
}

export function exactSource(source) {
  ensure(source && ["pr", "dev", "staging"].includes(source.channel) && positive(source.buildRunId) && positive(source.publicationAttempt) &&
    (source.channel === "pr" ? positive(source.prNumber) : source.prNumber === undefined), "An exact published build source is required")
  return {channel: source.channel, buildRunId: source.buildRunId, publicationAttempt: source.publicationAttempt,
    ...(source.channel === "pr" ? {prNumber: source.prNumber} : {})}
}

export function stableRequestId({occurrenceId, routineId: id, platform, source, routineRevision: revision}) {
  ensure(requestIdentity(occurrenceId) && routineId(id) && platforms.includes(platform), "Invalid routine request identity")
  ensure(revision === undefined || routineRevision(revision), "Invalid routine revision override")
  const sha256 = createHash("sha256").update(JSON.stringify([occurrenceId, id, platform, exactSource(source), revision ?? null])).digest("hex")
  return `routine-${sha256}`
}

/** Preparation has an immutable intent; executable input is committed only after description. */
function boundDispatchIntent(request) {
  const intent = request.dispatchIntent
  ensure(requestIdentity(request.requestId) && requestIdentity(request.hostId) && intent?.requestId === request.requestId &&
    routineId(intent.routineId) && platforms.includes(intent.platform) && routineRevision(intent.routineRevision) && requestIdentity(intent.laneId) &&
    /^[a-f0-9]{64}$/.test(request.dispatchIntentSha256 ?? "") && requestInputDigest(intent) === request.dispatchIntentSha256 &&
    isDeepStrictEqual(intent.build?.source, exactSource(intent.source)), "Request differs from its immutable dispatch intent")
  return intent
}

function executableSelection(request) {
  const input = request.input
  ensure(requestIdentity(request.requestId) && requestIdentity(request.hostId) && routineId(input?.routineId) &&
    platforms.includes(input.platform) && routineRevision(input.definitionRevision) && requestIdentity(input.laneId) &&
    /^[a-f0-9]{64}$/.test(request.inputSha256 ?? "") && requestInputDigest(input) === request.inputSha256,
    "Executable request differs from its immutable input")
  return input
}

/** Source custody precedes assignment; a valid portable request has no invented host or lane. */
function portableSelection(request) {
  const selection = request.fleetSelection
  ensure(requestIdentity(request.requestId) && selection?.requestId === request.requestId && routineId(selection.routineId) &&
    platforms.includes(selection.platform) && routineRevision(selection.routineRevision) &&
    /^[a-f0-9]{64}$/.test(request.fleetSelectionSha256 ?? "") && requestInputDigest(selection) === request.fleetSelectionSha256 &&
    selection.build?.repository === "Mentra-Community/MentraOS" && routineRevision(selection.build.headSha) &&
    selection.build.kind === (selection.platform === "android" ? "android-apk" : "mac-ci-package") &&
    selection.build.channel === selection.source?.channel && isDeepStrictEqual(selection.build.source, exactSource(selection.source)) &&
    (selection.routineSource === undefined || selection.routineSource.commit === selection.routineRevision) &&
    (selection.minimumFrameworkVersion === undefined || positive(selection.minimumFrameworkVersion)),
    "Request differs from its immutable portable selection")
  return selection
}

/** The same exact source follows a request from portable intake to actual lane execution. */
export function routineRequestSelection(request) {
  const portable = request.fleetSelection ? portableSelection(request) : null
  const bound = request.input ? executableSelection(request) : request.dispatchIntent ? boundDispatchIntent(request) : null
  if (portable && !bound) ensure(!request.hostId && !request.fleetBinding && !request.inputSha256 &&
    ["awaiting-source", "awaiting-runner", "terminal"].includes(request.state), "Portable request contains an unverified lane assignment")
  if (portable && bound) ensure(portable.routineId === bound.routineId && portable.platform === bound.platform &&
    portable.routineRevision === (request.input ? bound.definitionRevision : bound.routineRevision) &&
    isDeepStrictEqual(portable.build, bound.build) &&
    (portable.routineSource === undefined || isDeepStrictEqual(portable.routineSource, bound.routineSource)) &&
    portable.minimumFrameworkVersion === bound.minimumFrameworkVersion,
    "Bound execution changed its immutable portable selection")
  ensure(bound || portable, "Request has no immutable source selection")
  return bound ?? portable
}

export async function routineApi({token, operation, request, requestId = request?.requestId, routineIds, revision, fetchImpl = fetch}) {
  ensure(token && ["catalog", "dispatch", "detail"].includes(operation), "Routine API capability is missing")
  if (operation !== "catalog") ensure(requestIdentity(requestId), "Invalid routine request identity")
  if (operation === "dispatch") ensure(routineId(request?.routineId) && platforms.includes(request.platform) && exactSource(request.source) &&
    (request.routineRevision === undefined || routineRevision(request.routineRevision)), "Invalid routine dispatch")
  if (routineIds !== undefined) ensure(operation === "catalog" && Array.isArray(routineIds) && routineIds.length > 0 && routineIds.length <= 30 &&
    routineIds.every(routineId) && new Set(routineIds).size === routineIds.length, "Invalid selected routine catalog")
  ensure(revision === undefined || operation === 'catalog' && routineRevision(revision), 'Invalid exact catalog revision')
  const query = new URLSearchParams({...routineIds ? {routines: routineIds.join(',')} : {}, ...revision ? {revision} : {}}).toString()
  const path = operation === "catalog" ? `/routine-catalog${query ? `?${query}` : ""}`
    : `/routine-dispatches${operation === "detail" ? `/${encodeURIComponent(requestId)}` : ""}`
  let response
  try {response = await fetchImpl(`${ENDPOINT}${path}`, {method: operation === "dispatch" ? "POST" : "GET", redirect: "error",
    signal: AbortSignal.timeout(30_000), headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
    ...(operation === "dispatch" ? {body: JSON.stringify(request)} : {})})}
  catch {const error = new Error(`Routine API ${operation} response is unavailable`); error.retryable = true; throw error}
  if (!response.ok) {
    let message; try {message = (await response.json()).message} catch {}
    const error = new Error(`Routine API ${operation} failed (${response.status})${typeof message === "string" ? `: ${message.slice(0, 500)}` : ""}`)
    error.retryable = response.status >= 500 || response.status === 429
    error.httpStatus = response.status
    throw error
  }
  let result
  try {result = await response.json()}
  catch {const error = new Error(`Routine API ${operation} response body is unavailable`); error.retryable = true; throw error}
  if (operation === "catalog") {selectedCatalog(result); return result}
  const acknowledged = operation === "dispatch" ? result : result.request
  ensure(acknowledged?.requestId === requestId,
    "Routine API acknowledgement differs from its request")
  const selection = routineRequestSelection(acknowledged)
  if (request) ensure(selection.routineId === request.routineId && selection.platform === request.platform &&
    isDeepStrictEqual(acknowledged.input ? selection.build.source : selection.source, exactSource(request.source)) &&
    (request.routineRevision === undefined || (acknowledged.input ? selection.definitionRevision : selection.routineRevision) === request.routineRevision) &&
    (request.routineSource === undefined || isDeepStrictEqual(selection.routineSource, request.routineSource)) &&
    (request.minimumFrameworkVersion === undefined || selection.minimumFrameworkVersion === request.minimumFrameworkVersion),
    "Routine API changed the original routine or source")
  return result
}

const admissionReason = error => String(error?.message ?? "Routine API admission failed").replace(/[\r\n]/g, " ").slice(0, 600)

/** One POST; a lost acknowledgement is reconciled by the same ID, never another admission identity. */
export async function submitRoutineRequest({token, request, fetchImpl = fetch}) {
  const identity = {routineId: request.routineId, platform: request.platform, requestId: request.requestId}
  let dispatchError
  try {
    const acknowledged = await routineApi({token, operation: "dispatch", request, fetchImpl})
    return {...identity, status: "accepted", request: acknowledged}
  } catch (error) {
    if (!error.retryable) return {...identity, status: "failed", reason: admissionReason(error), retryable: false}
    dispatchError = error
  }
  try {
    const detail = await routineApi({token, operation: "detail", request, fetchImpl})
    return {...identity, status: "accepted", request: detail.request}
  } catch (error) {
    // HTTP failure/absence cannot settle a possibly committed POST. A contradictory acknowledgement is a hard refusal.
    if (!error.retryable && error.httpStatus === undefined)
      return {...identity, status: "failed", reason: admissionReason(error), retryable: false}
    return {...identity, status: "uncertain", reason: admissionReason(new Error(`${admissionReason(dispatchError)}; reconciliation: ${admissionReason(error)}`)), retryable: true}
  }
}

/** Refuse a report whose request, source, host or frozen definition is inconsistent. */
export function boundRoutineResult(detail) {
  const {request, result} = detail ?? {}, run = result?.run, input = request?.input
  ensure(requestIdentity(request?.requestId), "Missing accepted routine request")
  routineRequestSelection(request)
  if (!result) return terminalRequestResult(request)
  ensure(input, "Result has no executable input")
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
    catch (error) {if (!error.retryable && error.httpStatus !== 404) throw error}
    if (detail) {
      const row = boundRoutineResult(detail)
      if (row && (!detail.result || detail.result.uploadsComplete || now() >= deadline)) return detail
      if (now() >= deadline) throw new Error(`No published routine result for ${requestId}; inspect Core request state`)
    }
    ensure(now() < deadline, `Routine result API did not recover for ${requestId}`)
    await sleep(Math.min(30_000, deadline - now()))
  }
}
