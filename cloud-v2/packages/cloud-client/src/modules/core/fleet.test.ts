import {describe, expect, mock, test} from "bun:test"
import type {FleetReport, FleetReportAck} from "@mentra/cloud-protocol"
import {AuthExpiredError, AuthUnavailableError, HttpError} from "../../errors"
import {createHttpClient, type HttpClient} from "../../http"
import {Auth} from "../auth/auth"
import {DEFAULT_REFRESH_TOKEN_KEY, TokenStore} from "../auth/token-store"
import type {CloudClientTimers} from "../../timers"
import type {HttpTransport} from "../../transports"
import {Core} from "./core"
import {Fleet, type FleetReportOutcome} from "./fleet"

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

/** Retry delays run immediately so the idempotent retry path does not slow the suite. */
const instantTimers: CloudClientTimers = {
  setTimeout(callback) {
    queueMicrotask(callback)
    return 0
  },
  clearTimeout: () => undefined,
  setInterval: () => 0,
  clearInterval: () => undefined,
}

const PATH = "/api/client/fleet/report"

const batch: FleetReport = {
  schemaVersion: 1,
  records: [
    {
      schemaVersion: 1,
      recordId: "rec-1",
      phoneDeviceId: "phone-1",
      collectorSessionId: "session-1",
      sequence: 0,
      observedAt: "2026-10-13T12:00:00.000Z",
      capabilities: [],
      kind: "coverage_gap",
      payload: {reason: "queue_dropped", from: "2026-10-13T11:00:00.000Z", to: "2026-10-13T12:00:00.000Z"},
    },
  ],
}

const ack: FleetReportAck = {
  schemaVersion: 1,
  results: [
    {index: 0, recordId: "rec-1", status: "accepted"},
    {index: 1, status: "rejected", reasonCode: "schema_invalid"},
    {index: 2, recordId: "rec-3", status: "retryable", retryAfterSeconds: 12},
  ],
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {status, headers: {"Content-Type": "application/json", ...headers}})
}

function fleetWith(fetch: HttpTransport, getToken?: () => Promise<string>) {
  const http = createHttpClient({
    baseUrl: "https://core.test",
    logger,
    fetch,
    timers: instantTimers,
    getToken: getToken ?? (async () => "core-token"),
  })
  return new Fleet(http)
}

function answering(response: () => Response) {
  const fetch = mock(async (_input: unknown, _init?: unknown) => response())
  return {fetch: fetch as unknown as HttpTransport, calls: fetch}
}

async function outcomeFor(response: () => Response): Promise<FleetReportOutcome> {
  return fleetWith(answering(response).fetch).report(batch)
}

describe("Fleet.report request", () => {
  test("posts the batch to the phone's own Core as an idempotent authenticated POST", async () => {
    const post = mock(async () => ack)
    const fleet = new Fleet({post} as unknown as HttpClient)

    await fleet.report(batch)

    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith(PATH, batch, {idempotent: true})
  })

  test("passes the caller's abort signal through to the HTTP client", async () => {
    const post = mock(async () => ack)
    const fleet = new Fleet({post} as unknown as HttpClient)
    const controller = new AbortController()

    await fleet.report(batch, {signal: controller.signal})

    expect(post).toHaveBeenCalledWith(PATH, batch, {idempotent: true, signal: controller.signal})
  })

  test("passes a caller's bearer through to the HTTP client", async () => {
    const post = mock(async () => ack)
    const fleet = new Fleet({post} as unknown as HttpClient)

    await fleet.report(batch, {bearer: "checked-token"})

    expect(post).toHaveBeenCalledWith(PATH, batch, {idempotent: true, bearer: "checked-token"})
  })

  test("sends the caller's bearer, not one from the token source", async () => {
    const {fetch, calls} = answering(() => json(200, ack))
    const getToken = mock(async () => "token-source-token")

    await fleetWith(fetch, getToken).report(batch, {bearer: "checked-token"})

    const [, init] = calls.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer checked-token")
    expect(getToken).not.toHaveBeenCalled()
  })

  test("sends a JSON body with the Core bearer token to the Fleet path", async () => {
    const {fetch, calls} = answering(() => json(200, ack))

    await fleetWith(fetch).report(batch)

    expect(calls).toHaveBeenCalledTimes(1)
    const [url, init] = calls.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`https://core.test${PATH}`)
    expect(init.method).toBe("POST")
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer core-token")
    expect(JSON.parse(init.body as string)).toEqual(batch)
  })

  test("is exposed as cloud.core.fleet.report", async () => {
    const post = mock(async () => ack)
    const core = new Core({http: {post} as unknown as HttpClient})

    const {report} = core.fleet
    await expect(report(batch)).resolves.toEqual({kind: "results", ack})
    expect(post).toHaveBeenCalledWith(PATH, batch, {idempotent: true})
  })
})

describe("Fleet.report 200", () => {
  test("returns the per-record acknowledgement", async () => {
    await expect(outcomeFor(() => json(200, ack))).resolves.toEqual({kind: "results", ack})
  })

  test("returns an empty acknowledgement as results", async () => {
    await expect(outcomeFor(() => json(200, {schemaVersion: 1, results: []}))).resolves.toEqual({
      kind: "results",
      ack: {schemaVersion: 1, results: []},
    })
  })

  const malformed: Array<[string, () => Response]> = [
    ["a wrong schemaVersion", () => json(200, {schemaVersion: 2, results: []})],
    ["a missing schemaVersion", () => json(200, {results: []})],
    ["a missing results array", () => json(200, {schemaVersion: 1})],
    ["a results value that is not an array", () => json(200, {schemaVersion: 1, results: {0: "accepted"}})],
    ["a result that is not an object", () => json(200, {schemaVersion: 1, results: ["accepted"]})],
    [
      "a result without an index",
      () => json(200, {schemaVersion: 1, results: [{recordId: "rec-1", status: "accepted"}]}),
    ],
    ["a negative index", () => json(200, {schemaVersion: 1, results: [{index: -1, status: "accepted"}]})],
    ["a fractional index", () => json(200, {schemaVersion: 1, results: [{index: 0.5, status: "accepted"}]})],
    ["an index given as text", () => json(200, {schemaVersion: 1, results: [{index: "0", status: "accepted"}]})],
    ["a result without a status", () => json(200, {schemaVersion: 1, results: [{index: 0}]})],
    ["a status that is not text", () => json(200, {schemaVersion: 1, results: [{index: 0, status: 1}]})],
    [
      "a recordId that is not text",
      () => json(200, {schemaVersion: 1, results: [{index: 0, recordId: 7, status: "accepted"}]}),
    ],
    ["a JSON body of the wrong shape", () => json(200, [1, 2, 3])],
    ["a JSON null body", () => json(200, null)],
    ["an empty body", () => new Response("", {status: 200})],
    ["an HTML body (a captive portal)", () => new Response("<html>sign in</html>", {status: 200})],
  ]
  for (const [name, response] of malformed) {
    test(`treats ${name} as unavailable with no Retry-After`, async () => {
      await expect(outcomeFor(response)).resolves.toEqual({kind: "unavailable", retryAfterSeconds: null})
    })
  }

  test("ignores keys it does not know, at the top and in each result", async () => {
    await expect(
      outcomeFor(() =>
        json(200, {
          schemaVersion: 1,
          results: [{index: 0, recordId: "rec-1", status: "accepted", receivedAt: "2026-10-13T12:00:00.000Z"}],
          servedBy: "mfm-2",
          extra: true,
        }),
      ),
    ).resolves.toEqual({
      kind: "results",
      ack: {schemaVersion: 1, results: [{index: 0, recordId: "rec-1", status: "accepted"}]},
    })
  })

  test("a status it does not know is retryable, and keeps the record's index and ID", async () => {
    await expect(
      outcomeFor(() =>
        json(200, {
          schemaVersion: 1,
          results: [
            {index: 0, recordId: "rec-1", status: "deferred", retryAfterSeconds: 30},
            {index: 1, status: "quarantined", reasonCode: "held"},
          ],
        }),
      ),
    ).resolves.toEqual({
      kind: "results",
      ack: {
        schemaVersion: 1,
        results: [
          {index: 0, recordId: "rec-1", status: "retryable", retryAfterSeconds: 30},
          {index: 1, status: "retryable"},
        ],
      },
    })
  })

  test("a rejection with a reason it does not know is still a rejection, with that reason", async () => {
    await expect(
      outcomeFor(() =>
        json(200, {
          schemaVersion: 1,
          results: [{index: 0, recordId: "rec-1", status: "rejected", reasonCode: "too_old_now"}],
        }),
      ),
    ).resolves.toEqual({
      kind: "results",
      ack: {schemaVersion: 1, results: [{index: 0, recordId: "rec-1", status: "rejected", reasonCode: "too_old_now"}]},
    })
  })

  test("a rejection without a usable reason is still a rejection, without one", async () => {
    for (const reasonCode of [undefined, "Has Spaces and PRIVATE detail", 42, {nested: true}]) {
      await expect(
        outcomeFor(() =>
          json(200, {
            schemaVersion: 1,
            results: [{index: 0, status: "rejected", ...(reasonCode === undefined ? {} : {reasonCode})}],
          }),
        ),
      ).resolves.toEqual({kind: "results", ack: {schemaVersion: 1, results: [{index: 0, status: "rejected"}]}})
    }
  })

  test("a reason on a result that is not a rejection is dropped", async () => {
    await expect(
      outcomeFor(() =>
        json(200, {schemaVersion: 1, results: [{index: 0, status: "accepted", reasonCode: "schema_invalid"}]}),
      ),
    ).resolves.toEqual({kind: "results", ack: {schemaVersion: 1, results: [{index: 0, status: "accepted"}]}})
  })

  test("a Retry-After on a result that is not a whole number of seconds is ignored", async () => {
    for (const retryAfterSeconds of [-1, 1.5, "30", Number.MAX_SAFE_INTEGER + 2]) {
      await expect(
        outcomeFor(() => json(200, {schemaVersion: 1, results: [{index: 0, status: "retryable", retryAfterSeconds}]})),
      ).resolves.toEqual({kind: "results", ack: {schemaVersion: 1, results: [{index: 0, status: "retryable"}]}})
    }
  })

  test("does not let a Retry-After header turn a malformed 200 into a delay", async () => {
    await expect(outcomeFor(() => json(200, {schemaVersion: 2}, {"Retry-After": "30"}))).resolves.toEqual({
      kind: "unavailable",
      retryAfterSeconds: null,
    })
  })
})

describe("Fleet.report status mapping", () => {
  test("404 fleet_not_installed is not_installed", async () => {
    await expect(outcomeFor(() => json(404, {error: "fleet_not_installed"}))).resolves.toEqual({kind: "not_installed"})
  })

  test("a plain-text 404 (a Core without the Fleet route) is no_fleet_route, not not_installed", async () => {
    await expect(outcomeFor(() => new Response("404 Not Found", {status: 404}))).resolves.toEqual({
      kind: "no_fleet_route",
    })
    await expect(outcomeFor(() => new Response("<html>Not Found</html>", {status: 404}))).resolves.toEqual({
      kind: "no_fleet_route",
    })
    await expect(outcomeFor(() => new Response(null, {status: 404}))).resolves.toEqual({kind: "no_fleet_route"})
  })

  test("a JSON 404 with any other code, or none, is no_fleet_route", async () => {
    await expect(outcomeFor(() => json(404, {error: "not_found"}))).resolves.toEqual({kind: "no_fleet_route"})
    await expect(outcomeFor(() => json(404, {code: "route_missing"}))).resolves.toEqual({kind: "no_fleet_route"})
    await expect(outcomeFor(() => json(404, {message: "Not Found"}))).resolves.toEqual({kind: "no_fleet_route"})
  })

  test("a 404 with a Retry-After is still no_fleet_route", async () => {
    await expect(
      outcomeFor(() => new Response("Not Found", {status: 404, headers: {"Retry-After": "30"}})),
    ).resolves.toEqual({
      kind: "no_fleet_route",
    })
  })

  test("503 fleet_unavailable is unavailable and carries Retry-After seconds", async () => {
    await expect(outcomeFor(() => json(503, {error: "fleet_unavailable"}, {"Retry-After": "45"}))).resolves.toEqual({
      kind: "unavailable",
      retryAfterSeconds: 45,
    })
  })

  test("503 without Retry-After is unavailable with null", async () => {
    await expect(outcomeFor(() => json(503, {error: "fleet_unavailable"}))).resolves.toEqual({
      kind: "unavailable",
      retryAfterSeconds: null,
    })
  })

  test("429 with Retry-After is unavailable with those seconds", async () => {
    await expect(outcomeFor(() => json(429, {error: "rate_limited"}, {"Retry-After": "120"}))).resolves.toEqual({
      kind: "unavailable",
      retryAfterSeconds: 120,
    })
  })

  test("429 without Retry-After is unavailable with null", async () => {
    await expect(outcomeFor(() => json(429, {error: "rate_limited"}))).resolves.toEqual({
      kind: "unavailable",
      retryAfterSeconds: null,
    })
  })

  test("other server and gateway failures keep the queue as unavailable", async () => {
    for (const status of [408, 500, 502, 504]) {
      await expect(
        outcomeFor(() => new Response("upstream", {status, headers: {"Retry-After": "9"}})),
      ).resolves.toEqual({
        kind: "unavailable",
        retryAfterSeconds: 9,
      })
    }
  })

  test("an unlisted client error keeps the queue as unavailable", async () => {
    for (const status of [405, 410, 422]) {
      await expect(outcomeFor(() => json(status, {error: "whatever"}))).resolves.toEqual({
        kind: "unavailable",
        retryAfterSeconds: null,
      })
    }
  })

  test("413 payload_too_large is batch_too_large", async () => {
    await expect(outcomeFor(() => json(413, {error: "payload_too_large"}))).resolves.toEqual({kind: "batch_too_large"})
  })

  test("413 is batch_too_large even without a body", async () => {
    await expect(outcomeFor(() => new Response(null, {status: 413}))).resolves.toEqual({kind: "batch_too_large"})
  })

  test("400 carries Core's error code as batch_invalid", async () => {
    for (const code of ["invalid_batch", "invalid_body", "invalid_path", "unsupported_schema_version"]) {
      await expect(outcomeFor(() => json(400, {error: code}))).resolves.toEqual({kind: "batch_invalid", code})
    }
  })

  test("400 without a usable code is batch_invalid with code unknown", async () => {
    await expect(outcomeFor(() => new Response("Bad Request", {status: 400}))).resolves.toEqual({
      kind: "batch_invalid",
      code: "unknown",
    })
    await expect(outcomeFor(() => json(400, {error: {nested: true}}))).resolves.toEqual({
      kind: "batch_invalid",
      code: "unknown",
    })
    await expect(outcomeFor(() => json(400, {error: "has spaces and PRIVATE detail"}))).resolves.toEqual({
      kind: "batch_invalid",
      code: "unknown",
    })
  })

  test("403 forbidden is forbidden", async () => {
    await expect(outcomeFor(() => json(403, {error: "forbidden"}))).resolves.toEqual({kind: "forbidden"})
  })
})

describe("Fleet.report Retry-After parsing", () => {
  const retryAfter = (value: string) =>
    outcomeFor(() => json(503, {error: "fleet_unavailable"}, {"Retry-After": value}))

  test("reads delta-seconds", async () => {
    await expect(retryAfter("0")).resolves.toEqual({kind: "unavailable", retryAfterSeconds: 0})
    await expect(retryAfter("1")).resolves.toEqual({kind: "unavailable", retryAfterSeconds: 1})
    await expect(retryAfter("86400")).resolves.toEqual({kind: "unavailable", retryAfterSeconds: 86400})
    await expect(retryAfter(" 7 ")).resolves.toEqual({kind: "unavailable", retryAfterSeconds: 7})
  })

  test("ignores an HTTP-date", async () => {
    await expect(retryAfter("Wed, 21 Oct 2026 07:28:00 GMT")).resolves.toEqual({
      kind: "unavailable",
      retryAfterSeconds: null,
    })
  })

  test("ignores garbage, negatives, fractions, signs, exponents and absurd magnitudes", async () => {
    for (const value of [
      "",
      "soon",
      "-1",
      "+5",
      "1.5",
      "1e3",
      "0x10",
      "12s",
      "NaN",
      "Infinity",
      "99999999999999999999",
    ]) {
      await expect(retryAfter(value)).resolves.toEqual({kind: "unavailable", retryAfterSeconds: null})
    }
  })
})

describe("Fleet.report network failures", () => {
  test("a network error is unavailable with no Retry-After", async () => {
    const fetch = mock(async () => {
      throw new TypeError("Network request failed")
    }) as unknown as HttpTransport

    await expect(fleetWith(fetch).report(batch)).resolves.toEqual({kind: "unavailable", retryAfterSeconds: null})
  })

  test("retries a transient network error and then returns the acknowledgement", async () => {
    let calls = 0
    const fetch = mock(async () => {
      calls += 1
      if (calls < 3) throw new TypeError("Network request failed")
      return json(200, ack)
    }) as unknown as HttpTransport

    await expect(fleetWith(fetch).report(batch)).resolves.toEqual({kind: "results", ack})
    expect(calls).toBe(3)
  })

  test("a native timeout is unavailable with no Retry-After", async () => {
    const fetch = mock(async () => {
      throw Object.assign(new Error("timed out"), {code: "E_NATIVE_HTTP_TIMEOUT"})
    }) as unknown as HttpTransport

    await expect(fleetWith(fetch).report(batch)).resolves.toEqual({kind: "unavailable", retryAfterSeconds: null})
  })

  test("an AbortSignal.timeout style TimeoutError is unavailable, not a thrown abort", async () => {
    const fetch = mock(async () => {
      throw new DOMException("The operation timed out", "TimeoutError")
    }) as unknown as HttpTransport

    await expect(fleetWith(fetch).report(batch)).resolves.toEqual({kind: "unavailable", retryAfterSeconds: null})
  })
})

describe("Fleet.report throws only for auth and aborts", () => {
  test("a 401 throws the HttpError so the caller can refresh once", async () => {
    const error = await outcomeFor(() => json(401, {error: "unauthorized"})).catch((e) => e)
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).status).toBe(401)
  })

  test("a 401 without a body still throws", async () => {
    const error = await outcomeFor(() => new Response(null, {status: 401})).catch((e) => e)
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).status).toBe(401)
  })

  test("an expired session (AuthExpiredError from the token source) throws", async () => {
    const fetch = mock(async () => json(200, ack)) as unknown as HttpTransport
    const fleet = fleetWith(fetch, async () => {
      throw new AuthExpiredError("token refresh failed; re-auth required")
    })

    await expect(fleet.report(batch)).rejects.toBeInstanceOf(AuthExpiredError)
    expect(fetch).not.toHaveBeenCalled()
  })

  test("an AbortError from the transport propagates", async () => {
    const fetch = mock(async () => {
      throw new DOMException("The operation was aborted", "AbortError")
    }) as unknown as HttpTransport

    const error = await fleetWith(fetch)
      .report(batch)
      .catch((e) => e)
    expect(error).toBeInstanceOf(DOMException)
    expect((error as DOMException).name).toBe("AbortError")
  })

  test("a signal that is already aborted rejects with its reason and sends nothing", async () => {
    const {fetch, calls} = answering(() => json(200, ack))
    const controller = new AbortController()
    const reason = new Error("reporter stopped")
    controller.abort(reason)

    await expect(fleetWith(fetch).report(batch, {signal: controller.signal})).rejects.toBe(reason)
    expect(calls).not.toHaveBeenCalled()
  })

  test("aborting mid-flight rejects with the abort reason even when the transport reports a network error", async () => {
    const controller = new AbortController()
    const reason = new Error("engine stopped")
    const fetch = mock(async () => {
      controller.abort(reason)
      throw new TypeError("Network request failed")
    }) as unknown as HttpTransport

    await expect(fleetWith(fetch).report(batch, {signal: controller.signal})).rejects.toBe(reason)
  })

  test("aborting while a response is being read rejects instead of returning an outcome", async () => {
    const controller = new AbortController()
    const reason = new Error("engine stopped")
    const fetch = mock(async () => {
      const response = json(503, {error: "fleet_unavailable"})
      queueMicrotask(() => controller.abort(reason))
      return response
    }) as unknown as HttpTransport

    await expect(fleetWith(fetch).report(batch, {signal: controller.signal})).rejects.toBe(reason)
  })

  test("an AbortError raised while reading the body propagates even when the caller's signal is not aborted", async () => {
    const fetch = mock(async () =>
      bodyDroppedAfterHeaders(200, new DOMException("The operation was aborted", "AbortError")),
    )

    const error = await fleetWith(fetch as unknown as HttpTransport)
      .report(batch)
      .catch((e) => e)
    expect(error).toBeInstanceOf(DOMException)
    expect((error as DOMException).name).toBe("AbortError")
  })
})

describe("Fleet.report maps every other failure to unavailable", () => {
  const unavailableOutcome: FleetReportOutcome = {kind: "unavailable", retryAfterSeconds: null}

  test("a connection that drops while a 200 body is being read is unavailable", async () => {
    for (const failure of [
      new Error("The socket connection was closed unexpectedly"),
      new TypeError("Network request failed"),
      Object.assign(new Error("connection reset"), {code: "ECONNRESET"}),
    ]) {
      const fetch = mock(async () => bodyDroppedAfterHeaders(200, failure))
      await expect(fleetWith(fetch as unknown as HttpTransport).report(batch)).resolves.toEqual(unavailableOutcome)
      // The body read is past the retry loop, so the batch is sent once and left to the caller's own backoff.
      expect(fetch).toHaveBeenCalledTimes(1)
    }
  })

  test("a connection that drops after part of the 200 body arrived is unavailable", async () => {
    const fetch = mock(async () => bodyDroppedAfterHeaders(200, new Error("socket closed"), '{"schemaVersion":1,"res'))

    await expect(fleetWith(fetch as unknown as HttpTransport).report(batch)).resolves.toEqual(unavailableOutcome)
  })

  test("a connection that drops while an error body is being read keeps the status mapping", async () => {
    const fetch = mock(async () =>
      bodyDroppedAfterHeaders(503, new Error("socket closed"), undefined, {"Retry-After": "21"}),
    )

    await expect(fleetWith(fetch as unknown as HttpTransport).report(batch)).resolves.toEqual({
      kind: "unavailable",
      retryAfterSeconds: 21,
    })
  })

  test("an unexpected error from the HTTP client is unavailable", async () => {
    for (const failure of [new RangeError("unexpected"), new Error("plain"), "a thrown string", undefined]) {
      const fleet = new Fleet({
        post: async () => {
          throw failure
        },
      } as unknown as HttpClient)

      await expect(fleet.report(batch)).resolves.toEqual(unavailableOutcome)
    }
  })

  test("a token source failure that is not an auth error is unavailable", async () => {
    const fetch = mock(async () => json(200, ack)) as unknown as HttpTransport
    const fleet = fleetWith(fetch, async () => {
      throw new Error("secure storage is unavailable")
    })

    await expect(fleet.report(batch)).resolves.toEqual(unavailableOutcome)
    expect(fetch).not.toHaveBeenCalled()
  })

  test("a token source that cannot refresh for a transient reason (AuthUnavailableError) is unavailable", async () => {
    const fetch = mock(async () => json(200, ack)) as unknown as HttpTransport
    const fleet = fleetWith(fetch, async () => {
      throw new AuthUnavailableError("token refresh could not be completed; try again later", {status: 503})
    })

    await expect(fleet.report(batch)).resolves.toEqual(unavailableOutcome)
    expect(fetch).not.toHaveBeenCalled()
  })

  test("a non-401 HttpError from the client is still mapped by status", async () => {
    const fleet = new Fleet({
      post: async () => {
        throw new HttpError("HTTP 413", 413, "payload_too_large")
      },
    } as unknown as HttpClient)

    await expect(fleet.report(batch)).resolves.toEqual({kind: "batch_too_large"})
  })
})

/** A response whose headers arrive and whose body stream then fails, as when the socket closes mid-read. */
function bodyDroppedAfterHeaders(
  status: number,
  failure: unknown,
  partial?: string,
  headers: Record<string, string> = {},
): Response {
  const encoder = new TextEncoder()
  let sentPartial = partial === undefined
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sentPartial) {
        sentPartial = true
        controller.enqueue(encoder.encode(partial))
        return
      }
      controller.error(failure)
    },
  })
  return new Response(body, {status, headers})
}

describe("Fleet.report with the real Auth as the token source", () => {
  const unavailableOutcome: FleetReportOutcome = {kind: "unavailable", retryAfterSeconds: null}

  const jwt = () => {
    const payload = Buffer.from(
      JSON.stringify({sub: "account-1", tenant_id: "consumer", exp: Math.floor(Date.now() / 1000) + 3600}),
    ).toString("base64url")
    return `e30.${payload}.test`
  }

  /** Fleet over an Auth holding a refresh token, whose `/refresh` answers as `refresh` says. */
  function fleetOverAuth(refresh: () => Response, refreshToken: string | null = "refresh-1") {
    const values = new Map<string, string>()
    if (refreshToken !== null) values.set(DEFAULT_REFRESH_TOKEN_KEY, refreshToken)
    const storage = {
      get: async (key: string) => values.get(key) ?? null,
      set: async (key: string, value: string) => {
        values.set(key, value)
      },
      delete: async (key: string) => {
        values.delete(key)
      },
    }
    const auth = new Auth({
      store: new TokenStore({storage}),
      config: {core: {subjectToken: "subject", subjectTokenType: "oidc"}, runtime: {source: "core"}},
      logger,
      baseUrl: "https://core.test",
      fetch: (async () => refresh()) as unknown as HttpTransport,
    })
    const reportFetch = mock(async () => json(200, ack))
    const fleet = fleetWith(reportFetch as unknown as HttpTransport, () => auth.getCoreToken())
    return {fleet, reportFetch, storage}
  }

  test("a refresh that fails on the network is unavailable and keeps the refresh token", async () => {
    const {fleet, reportFetch, storage} = fleetOverAuth(() => {
      throw new TypeError("Network request failed")
    })

    await expect(fleet.report(batch)).resolves.toEqual(unavailableOutcome)
    expect(reportFetch).not.toHaveBeenCalled()
    expect(await storage.get(DEFAULT_REFRESH_TOKEN_KEY)).toBe("refresh-1")
  })

  test("a refresh answered with a 503 is unavailable and keeps the refresh token", async () => {
    const {fleet, reportFetch, storage} = fleetOverAuth(() => json(503, {error: "temporarily_unavailable"}))

    await expect(fleet.report(batch)).resolves.toEqual(unavailableOutcome)
    expect(reportFetch).not.toHaveBeenCalled()
    expect(await storage.get(DEFAULT_REFRESH_TOKEN_KEY)).toBe("refresh-1")
  })

  test("a first-use exchange answered with a 503 is unavailable, not an auth failure", async () => {
    const {fleet, reportFetch, storage} = fleetOverAuth(() => json(503, {error: "temporarily_unavailable"}), null)

    await expect(fleet.report(batch)).resolves.toEqual(unavailableOutcome)
    expect(reportFetch).not.toHaveBeenCalled()
    expect(await storage.get(DEFAULT_REFRESH_TOKEN_KEY)).toBeNull()
  })

  test("a first-use exchange Core refuses still throws AuthExpiredError", async () => {
    const {fleet, reportFetch} = fleetOverAuth(() => json(400, {error: "invalid_grant"}), null)

    await expect(fleet.report(batch)).rejects.toBeInstanceOf(AuthExpiredError)
    expect(reportFetch).not.toHaveBeenCalled()
  })

  test("a refresh token Core rejects still throws AuthExpiredError", async () => {
    const {fleet, reportFetch, storage} = fleetOverAuth(() => json(400, {error: "invalid_grant"}))

    await expect(fleet.report(batch)).rejects.toBeInstanceOf(AuthExpiredError)
    expect(reportFetch).not.toHaveBeenCalled()
    expect(await storage.get(DEFAULT_REFRESH_TOKEN_KEY)).toBeNull()
  })

  test("a refresh that succeeds sends the report", async () => {
    const {fleet, reportFetch} = fleetOverAuth(() =>
      json(200, {access_token: jwt(), refresh_token: "refresh-2", token_type: "Bearer", expires_in: 3600}),
    )

    await expect(fleet.report(batch)).resolves.toMatchObject({kind: "results"})
    expect(reportFetch).toHaveBeenCalledTimes(1)
  })
})
