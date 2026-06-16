/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import {
  makeRequestId,
  MiniappEnvelope,
  parseEnvelope,
  serializeEnvelope,
} from "./envelope"

describe("envelope roundtrip", () => {
  test("serialize + parse returns the same shape", () => {
    const env: MiniappEnvelope = {
      payload: {type: "miniapp_display", layout: "text_wall", text: "hello"},
      requestId: "req_abc",
    }
    const raw = serializeEnvelope(env)
    const parsed = parseEnvelope(raw)
    expect(parsed).not.toBeNull()
    expect(parsed!.requestId).toBe("req_abc")
    expect((parsed!.payload as Record<string, unknown>).type).toBe("miniapp_display")
  })

  test("envelope without requestId round-trips", () => {
    const env: MiniappEnvelope = {
      payload: {type: "miniapp_ping"},
    }
    const parsed = parseEnvelope(serializeEnvelope(env))
    expect(parsed).not.toBeNull()
    expect(parsed!.requestId).toBeUndefined()
  })
})

describe("envelope parsing error tolerance", () => {
  test("returns null for non-string input", () => {
    expect(parseEnvelope(null)).toBeNull()
    expect(parseEnvelope(undefined)).toBeNull()
    expect(parseEnvelope(123)).toBeNull()
    expect(parseEnvelope({payload: {}})).toBeNull()
  })

  test("returns null for malformed JSON", () => {
    expect(parseEnvelope("not json")).toBeNull()
    expect(parseEnvelope("{")).toBeNull()
  })

  test("returns null for missing payload", () => {
    expect(parseEnvelope(JSON.stringify({}))).toBeNull()
    expect(parseEnvelope(JSON.stringify({payload: null}))).toBeNull()
    expect(parseEnvelope(JSON.stringify({payload: "string"}))).toBeNull()
  })

  test("returns null when requestId is present but not a string", () => {
    expect(
      parseEnvelope(JSON.stringify({payload: {}, requestId: 123})),
    ).toBeNull()
  })

  test("accepts optional requestId", () => {
    const parsed = parseEnvelope(JSON.stringify({payload: {}}))
    expect(parsed).not.toBeNull()
  })

  test("extra fields are tolerated", () => {
    const parsed = parseEnvelope(JSON.stringify({payload: {type: "test"}, extra: "ignored"}))
    expect(parsed).not.toBeNull()
    expect((parsed!.payload as Record<string, unknown>).type).toBe("test")
  })
})

describe("makeRequestId", () => {
  test("generates unique values", () => {
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) ids.add(makeRequestId())
    expect(ids.size).toBe(100)
  })

  test("returns non-empty strings", () => {
    const id = makeRequestId()
    expect(typeof id).toBe("string")
    expect(id.length).toBeGreaterThan(0)
  })
})
