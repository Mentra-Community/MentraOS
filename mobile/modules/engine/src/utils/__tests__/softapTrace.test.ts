/// <reference types="bun-types" />

import {afterEach, beforeEach, describe, expect, test} from "bun:test"

import {
  beginSoftapTrace,
  formatSoftapTrace,
  newSoftapTraceId,
  resetSoftapTrace,
  sanitizeSoftapData,
  sanitizeSoftapField,
  softapLastStage,
  softapTrace,
  softapTraceFailure,
  softapTraceId,
  SOFTAP_TRACE_MARKER,
} from "../softapTrace"

const originalLog = console.log
const originalWarn = console.warn
let logged: unknown[][] = []
let warned: unknown[][] = []

beforeEach(() => {
  logged = []
  warned = []
  console.log = (...args: unknown[]) => {
    logged.push(args)
  }
  console.warn = (...args: unknown[]) => {
    warned.push(args)
  }
  resetSoftapTrace()
})

afterEach(() => {
  console.log = originalLog
  console.warn = originalWarn
  resetSoftapTrace()
})

describe("softapTrace formatting", () => {
  test("every line carries the grep marker", () => {
    softapTrace("hotspot_requested")
    expect(String(logged[0][0])).toContain(SOFTAP_TRACE_MARKER)
  })

  test("includes traceId, phase, and elapsedMs once begun", () => {
    beginSoftapTrace("abc123")
    softapTrace("scoped_network_available")
    const head = String(logged[0][0])
    expect(head).toContain("traceId=abc123")
    expect(head).toContain("phase=scoped_network_available")
    expect(head).toContain("elapsedMs=")
  })

  test("omits traceId before the trace has begun", () => {
    expect(formatSoftapTrace("", "boot", 0)).toBe("[SOFTAP_TRACE] phase=boot elapsedMs=0")
  })

  test("beginSoftapTrace returns and stores the id", () => {
    const id = beginSoftapTrace("fixed-id")
    expect(id).toBe("fixed-id")
    expect(softapTraceId()).toBe("fixed-id")
  })

  test("tracks the last stage for failure context", () => {
    beginSoftapTrace("t")
    softapTrace("listener_bound")
    expect(softapLastStage()).toBe("listener_bound")
    softapTraceFailure("whip_post_failed")
    expect(warned[0][1]).toMatchObject({afterStage: "listener_bound"})
  })

  test("newSoftapTraceId produces distinct ids", () => {
    const ids = new Set(Array.from({length: 20}, () => newSoftapTraceId()))
    expect(ids.size).toBeGreaterThan(1)
  })
})

describe("softapTrace redaction", () => {
  test("redacts the hotspot password", () => {
    expect(sanitizeSoftapField("password", "hunter2")).toBe("<redacted>")
    expect(sanitizeSoftapField("hotspotPassword", "hunter2")).toBe("<redacted>")
    expect(sanitizeSoftapField("psk", "hunter2")).toBe("<redacted>")
    expect(sanitizeSoftapField("passphrase", "hunter2")).toBe("<redacted>")
  })

  test("redacts tokens, credentials, and the meeting URL", () => {
    expect(sanitizeSoftapField("token", "eyJhbGciOi")).toBe("<redacted>")
    expect(sanitizeSoftapField("acsToken", "eyJhbGciOi")).toBe("<redacted>")
    expect(sanitizeSoftapField("Authorization", "Bearer x")).toBe("<redacted>")
    expect(sanitizeSoftapField("meetingUrl", "https://teams.microsoft.com/l/x")).toBe("<redacted>")
  })

  test("a logged payload never leaks a secret value", () => {
    beginSoftapTrace("t")
    softapTrace("hotspot_started", {ssid: "MentraLive", password: "hunter2"})
    const payload = JSON.stringify(logged[0][1])
    expect(payload).not.toContain("hunter2")
    expect(payload).toContain("MentraLive")
    expect(payload).toContain("<redacted>")
  })

  test("keeps the local WHIP URL, which is diagnostic", () => {
    expect(sanitizeSoftapField("whipUrl", "http://192.168.43.20:8790/whip/abc")).toBe(
      "http://192.168.43.20:8790/whip/abc",
    )
  })

  test("strips query strings that may carry tokens", () => {
    expect(sanitizeSoftapField("playbackUrl", "https://example.com/live?token=secret123")).toBe(
      "https://example.com/live?<redacted>",
    )
  })

  test("strips userinfo from URLs", () => {
    const result = String(sanitizeSoftapField("endpoint", "https://user:pw@example.com/x"))
    expect(result).not.toContain("pw@")
    expect(result).toContain("<redacted>@example.com/x")
  })

  test("leaves non-string values alone", () => {
    expect(sanitizeSoftapField("status", 201)).toBe(201)
    expect(sanitizeSoftapField("ok", true)).toBe(true)
    expect(sanitizeSoftapField("missing", null)).toBe(null)
  })

  test("sanitizeSoftapData maps every key", () => {
    expect(sanitizeSoftapData({ssid: "x", token: "y", status: 201})).toEqual({
      ssid: "x",
      token: "<redacted>",
      status: 201,
    })
  })
})
