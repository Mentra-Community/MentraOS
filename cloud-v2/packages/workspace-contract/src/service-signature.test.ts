import {describe, expect, test} from "bun:test"
import {SERVICE_HEADERS, signServiceRequest, verifyServiceRequest} from "./service-signature"

const base = {method: "POST", pathWithQuery: "/api/internal/workspaces/authorize", body: "{}", timestampMs: 1_000}

describe("service request signatures", () => {
  test("verifies a signature and rejects body, path, skew and secret changes", () => {
    const signature = signServiceRequest({...base, secret: "s1"})
    expect(verifyServiceRequest({...base, secrets: ["old", "s1"], signature, nowMs: 1_000})).toBe(true)
    expect(verifyServiceRequest({...base, body: "{ }", secrets: ["s1"], signature, nowMs: 1_000})).toBe(false)
    expect(verifyServiceRequest({...base, pathWithQuery: "/x", secrets: ["s1"], signature, nowMs: 1_000})).toBe(false)
    expect(verifyServiceRequest({...base, secrets: ["s1"], signature, nowMs: 62_000})).toBe(false)
    expect(verifyServiceRequest({...base, secrets: ["s2"], signature, nowMs: 1_000})).toBe(false)
  })

  test("binds the method, the query string and the timestamp", () => {
    const withQuery = {
      ...base,
      method: "GET",
      pathWithQuery: "/api/internal/workspaces/changes?after=a&limit=5",
      body: "",
    }
    const signature = signServiceRequest({...withQuery, secret: "s1"})
    expect(verifyServiceRequest({...withQuery, secrets: ["s1"], signature, nowMs: 1_000})).toBe(true)
    expect(verifyServiceRequest({...withQuery, method: "POST", secrets: ["s1"], signature, nowMs: 1_000})).toBe(false)
    expect(
      verifyServiceRequest({
        ...withQuery,
        pathWithQuery: "/api/internal/workspaces/changes?after=b&limit=5",
        secrets: ["s1"],
        signature,
        nowMs: 1_000,
      }),
    ).toBe(false)
    expect(verifyServiceRequest({...withQuery, timestampMs: 1_001, secrets: ["s1"], signature, nowMs: 1_001})).toBe(
      false,
    )
  })

  test("signs the documented base64url HMAC-SHA256 string", () => {
    const signature = signServiceRequest({...base, secret: "s1"})
    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(signServiceRequest({...base, secret: "s1"})).toBe(signature)
    expect(signServiceRequest({...base, secret: "s2"})).not.toBe(signature)
  })

  test("accepts timestamps within the skew window in either direction and honours maxSkewMs", () => {
    const signature = signServiceRequest({...base, secret: "s1"})
    const verify = (nowMs: number, maxSkewMs?: number) =>
      verifyServiceRequest({...base, secrets: ["s1"], signature, nowMs, maxSkewMs})
    expect(verify(61_000)).toBe(true)
    expect(verify(61_001)).toBe(false)
    expect(verify(0)).toBe(true) // clock slightly behind the signer
    expect(verify(-60_001)).toBe(false)
    expect(verify(5_000, 1_000)).toBe(false)
    expect(verify(1_500, 1_000)).toBe(true)
  })

  test("rejects malformed signatures, an empty secret list and a non-finite timestamp", () => {
    const signature = signServiceRequest({...base, secret: "s1"})
    expect(verifyServiceRequest({...base, secrets: ["s1"], signature: "", nowMs: 1_000})).toBe(false)
    expect(verifyServiceRequest({...base, secrets: ["s1"], signature: signature.slice(1), nowMs: 1_000})).toBe(false)
    expect(verifyServiceRequest({...base, secrets: ["s1"], signature: `${signature}x`, nowMs: 1_000})).toBe(false)
    expect(verifyServiceRequest({...base, secrets: [], signature, nowMs: 1_000})).toBe(false)
    expect(verifyServiceRequest({...base, secrets: ["s1"], signature, nowMs: Number.NaN})).toBe(false)
  })

  test("exposes the header names", () => {
    expect(SERVICE_HEADERS).toEqual({
      service: "x-mentra-service",
      timestamp: "x-mentra-service-timestamp",
      signature: "x-mentra-service-signature",
    })
  })
})
