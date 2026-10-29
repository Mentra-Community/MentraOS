import {FLEET_NOT_INSTALLED, FLEET_SCHEMA_VERSION, type FleetReport} from "@mentra/cloud-protocol"
import {AuthExpiredError, HttpError} from "../../errors"
import type {HttpClient} from "../../http"

const FLEET_REPORT_PATH = "/api/client/fleet/report"

/** Core's whole-response error codes are short snake_case words; anything else is not safe to surface. */
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

const RESULT_STATUSES = ["accepted", "duplicate", "retryable", "rejected"] as const

/**
 * Fleet's answer for one record of the batch, as this client reads it. `index` is the record's position in the batch
 * and `recordId`, when present, names it. A status this client does not know reads as `retryable`, so the record is
 * kept and sent again. `reasonCode` is given only for a rejection, and only when it is a short snake_case code; one
 * this client does not know is kept as given.
 */
export interface FleetAckResult {
  index: number
  recordId?: string
  status: (typeof RESULT_STATUSES)[number]
  reasonCode?: string
  retryAfterSeconds?: number
}

/** A per-record acknowledgement: one result per record Fleet answered for. */
export interface FleetAck {
  schemaVersion: typeof FLEET_SCHEMA_VERSION
  results: FleetAckResult[]
}

/**
 * What one `POST /api/client/fleet/report` came to. Every answer Core or Fleet can give is an outcome, so a caller
 * branches on `kind` and never on an exception or a status code.
 */
export type FleetReportOutcome =
  /** Core answered 200 with a per-record acknowledgement. */
  | {kind: "results"; ack: FleetAck}
  /** Core answered 404 `fleet_not_installed`: Fleet is not installed on this Core. */
  | {kind: "not_installed"}
  /**
   * Something answered 404 without Fleet's own code: a Core from before Fleet, which has no such route, or a proxy in
   * front of it. Not proof that Fleet is not installed, so a caller stops asking for now but keeps what it holds.
   */
  | {kind: "no_fleet_route"}
  /**
   * Fleet or the network is not answering usefully right now: 503, 429, any other server or unexpected failure, a
   * network error or timeout, or a 200 whose body is not an acknowledgement. `retryAfterSeconds` is the server's
   * `Retry-After` in whole seconds, or null when it gave none.
   */
  | {kind: "unavailable"; retryAfterSeconds: number | null}
  /** Core answered 413. */
  | {kind: "batch_too_large"}
  /** Core answered 400. `code` is Core's error code (`invalid_batch`, `invalid_body`, ...), or `unknown`. */
  | {kind: "batch_invalid"; code: string}
  /** Core answered 403. */
  | {kind: "forbidden"}

const unavailable = (retryAfterSeconds: number | null = null): FleetReportOutcome => ({
  kind: "unavailable",
  retryAfterSeconds,
})

/** The caller (or the transport) cancelled the request. */
function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
}

/** The credentials were refused or are gone: the caller must refresh or sign in again, so this is never an outcome. */
function isAuthFailure(error: unknown): boolean {
  return error instanceof AuthExpiredError || (error instanceof HttpError && error.status === 401)
}

function outcomeForHttpError(error: HttpError): FleetReportOutcome {
  switch (error.status) {
    // A transport failure (DNS, reset, timeout) after the client's own retries. There was no answer.
    case 0:
      return unavailable()
    case 404:
      // Only Fleet's own answer means "not installed". Any other 404 (an older Core without the route, a proxy) must
      // not read as it, because not_installed makes the caller drop its queue.
      return error.code === FLEET_NOT_INSTALLED ? {kind: "not_installed"} : {kind: "no_fleet_route"}
    case 413:
      return {kind: "batch_too_large"}
    case 400:
      return {
        kind: "batch_invalid",
        code: typeof error.code === "string" && ERROR_CODE_PATTERN.test(error.code) ? error.code : "unknown",
      }
    case 403:
      return {kind: "forbidden"}
    // 503, 429, 408, 5xx, and anything else Core was not documented to say: keep the records and try later.
    default:
      return unavailable(error.retryAfterSeconds)
  }
}

export class Fleet {
  constructor(private readonly http: HttpClient) {}

  /**
   * Reports one batch of Fleet records to the phone's own Core.
   *
   * Rejects in exactly two cases: an authentication failure (`AuthExpiredError`, or an `HttpError` with status 401),
   * or an abort (an `AbortError`, or any error raised once `opts.signal` is aborted). Every other result is a
   * {@link FleetReportOutcome}, including network failures, timeouts, a connection that drops while the response
   * body is being read, a body that is not a valid acknowledgement, and unexpected errors, which are
   * `{kind: "unavailable", retryAfterSeconds: null}`.
   *
   * The request is sent idempotently, so the HTTP client retries a transient network failure before the body is
   * read; that is safe because Fleet records are idempotent by ID.
   *
   * `opts.bearer` sends exactly that Core token instead of asking the token source, for a caller that has already
   * checked whose token it is.
   */
  async report(batch: FleetReport, opts?: {signal?: AbortSignal; bearer?: string}): Promise<FleetReportOutcome> {
    const signal = opts?.signal
    const bearer = opts?.bearer
    let body: unknown
    try {
      body = await this.http.post<unknown>(FLEET_REPORT_PATH, batch, {
        idempotent: true,
        ...(signal ? {signal} : {}),
        ...(bearer ? {bearer} : {}),
      })
    } catch (error) {
      // The caller stopped the request: that is its answer, whatever the transport happened to report.
      if (signal?.aborted || isAbortError(error) || isAuthFailure(error)) throw error
      if (error instanceof HttpError) return outcomeForHttpError(error)
      // Anything else (a body that is not JSON, a socket that closed mid-body, a failing token source) is no answer.
      return unavailable()
    }

    const ack = readAck(body)
    return ack ? {kind: "results", ack} : unavailable()
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isWholeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

/**
 * Reads an acknowledgement the way a client already in the field must: it ignores keys it does not know, reads a
 * status it does not know as `retryable`, and keeps a rejection whose reason it does not know. A newer Fleet can
 * therefore add to the answer without this client reading all of it as no answer and resending the same batch
 * forever. What it cannot do without is the shape that ties a result to a record: a `results` array of objects,
 * each with a whole-number `index`, a text `status`, and a `recordId` that is text when present. Anything else is
 * null, which the caller treats as no answer.
 *
 * Producers are still held to the strict `FleetReportAckSchema` in `@mentra/cloud-protocol`.
 */
function readAck(body: unknown): FleetAck | null {
  if (!isObject(body) || body.schemaVersion !== FLEET_SCHEMA_VERSION || !Array.isArray(body.results)) return null
  const results: FleetAckResult[] = []
  for (const raw of body.results) {
    if (!isObject(raw) || !isWholeNumber(raw.index) || typeof raw.status !== "string") return null
    if (raw.recordId !== undefined && typeof raw.recordId !== "string") return null
    const status = (RESULT_STATUSES as readonly string[]).includes(raw.status)
      ? (raw.status as FleetAckResult["status"])
      : "retryable"
    const result: FleetAckResult = {index: raw.index, status}
    if (raw.recordId !== undefined) result.recordId = raw.recordId
    if (status === "rejected" && typeof raw.reasonCode === "string" && ERROR_CODE_PATTERN.test(raw.reasonCode)) {
      result.reasonCode = raw.reasonCode
    }
    if (isWholeNumber(raw.retryAfterSeconds)) result.retryAfterSeconds = raw.retryAfterSeconds
    results.push(result)
  }
  return {schemaVersion: FLEET_SCHEMA_VERSION, results}
}
