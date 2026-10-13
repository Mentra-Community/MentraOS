import {FLEET_NOT_INSTALLED, FleetReportAckSchema, type FleetReport, type FleetReportAck} from "@mentra/cloud-protocol"
import {HttpError} from "../../errors"
import type {HttpClient} from "../../http"

const FLEET_REPORT_PATH = "/api/client/fleet/report"

/** Core's whole-response error codes are short snake_case words; anything else is not safe to surface. */
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

/**
 * What one `POST /api/client/fleet/report` came to. Every answer Core or Fleet can give is an outcome, so a caller
 * branches on `kind` and never on an exception or a status code.
 */
export type FleetReportOutcome =
  /** Core answered 200 with a valid per-record acknowledgement. */
  | {kind: "results"; ack: FleetReportAck}
  /** Core answered 404 `fleet_not_installed`. */
  | {kind: "not_installed"}
  /**
   * Fleet or the network is not answering usefully right now: 503, 429, any other server or unexpected failure, a
   * network error or timeout, or a 200 whose body is not a valid acknowledgement. `retryAfterSeconds` is the server's
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

/** A 200 whose body is not JSON at all (a captive portal's page, for example) is not an acknowledgement either. */
function isMalformedBody(error: unknown): boolean {
  return error instanceof SyntaxError
}

function outcomeForHttpError(error: HttpError): FleetReportOutcome {
  switch (error.status) {
    // A transport failure (DNS, reset, timeout) after the client's own retries. There was no answer.
    case 0:
      return unavailable()
    case 404:
      // Only Fleet's own answer means "not installed". A bare 404 (an older Core without the route, a proxy) must
      // not read as it, because not_installed makes the caller drop its queue.
      return error.code === FLEET_NOT_INSTALLED ? {kind: "not_installed"} : unavailable(error.retryAfterSeconds)
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
   * Throws only for authentication (`AuthExpiredError`, or an `HttpError` with status 401) and for aborts; every
   * answer from Fleet is a {@link FleetReportOutcome}. The request is sent idempotently, so a transient network
   * failure is retried by the HTTP client; that is safe because Fleet records are idempotent by ID.
   */
  async report(batch: FleetReport, opts?: {signal?: AbortSignal}): Promise<FleetReportOutcome> {
    const signal = opts?.signal
    let body: unknown
    try {
      body = await this.http.post<unknown>(FLEET_REPORT_PATH, batch, {
        idempotent: true,
        ...(signal ? {signal} : {}),
      })
    } catch (error) {
      // The caller stopped the request: that is its answer, whatever the transport happened to report.
      if (signal?.aborted) throw error
      if (error instanceof HttpError && error.status !== 401) return outcomeForHttpError(error)
      if (isMalformedBody(error)) return unavailable()
      // Auth failures (AuthExpiredError, 401), AbortErrors and anything unexpected are the caller's to handle.
      throw error
    }

    const ack = FleetReportAckSchema.safeParse(body)
    return ack.success ? {kind: "results", ack: ack.data} : unavailable()
  }
}
