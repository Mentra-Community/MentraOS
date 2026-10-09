import {describe, expect, test} from "bun:test"
import {createHmac} from "node:crypto"
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

  test("matches known-answer vectors computed independently of this module", () => {
    // Computed once with node:crypto over "<ts>\n<METHOD>\n<pathWithQuery>\n<sha256hex(body)>"; do not regenerate
    // these from signServiceRequest, they pin the wire format shared with the Store and Fleet integrations.
    const post = {
      secret: "known-answer-secret",
      method: "POST",
      pathWithQuery: "/api/internal/workspaces/authorize",
      body: '{"credential":{"type":"mentra_user","mentraUserId":"user_1"}}',
      timestampMs: 1_700_000_000_000,
    }
    expect(signServiceRequest(post)).toBe("xfy3gn_baTCt6aTUQ_cqs_E_Zm8kE1b4Ue_vKc4F3Ko")
    const get = {
      secret: "known-answer-secret",
      method: "GET",
      pathWithQuery: "/api/internal/workspaces/changes?after=abc&limit=100",
      body: "",
      timestampMs: 1_700_000_000_000,
    }
    expect(signServiceRequest(get)).toBe("xS_WFYqxy44wawNhjro4C71KeDIDiVxns1e5N7z4L_I")
    expect(signServiceRequest({...get, method: "get"})).toBe("xS_WFYqxy44wawNhjro4C71KeDIDiVxns1e5N7z4L_I")
    expect(
      verifyServiceRequest({
        ...get,
        secrets: ["known-answer-secret"],
        signature: "xS_WFYqxy44wawNhjro4C71KeDIDiVxns1e5N7z4L_I",
        nowMs: get.timestampMs,
      }),
    ).toBe(true)
  })

  test("refuses to sign with an empty or whitespace-only secret", () => {
    expect(() => signServiceRequest({...base, secret: ""})).toThrow()
    expect(() => signServiceRequest({...base, secret: "   "})).toThrow()
  })

  test("never verifies against an empty secret, so a signature made with one is not forgeable", () => {
    const forged = createHmac("sha256", "")
      .update(
        `${base.timestampMs}\n${base.method}\n${base.pathWithQuery}\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`,
      )
      .digest("base64url")
    const attempt = {...base, body: "", signature: forged, nowMs: 1_000}
    expect(verifyServiceRequest({...attempt, secrets: [""]})).toBe(false)
    expect(verifyServiceRequest({...attempt, secrets: ["", "  "]})).toBe(false)
    expect(verifyServiceRequest({...attempt, secrets: []})).toBe(false)
    expect(verifyServiceRequest({...attempt, secrets: ["", "s1"]})).toBe(false)
  })

  test("still verifies a real secret that sits next to an empty one in the rotation list", () => {
    const signature = signServiceRequest({...base, secret: "s1"})
    expect(verifyServiceRequest({...base, secrets: ["", "  ", "s1"], signature, nowMs: 1_000})).toBe(true)
  })

  test("treats a non-finite or negative maxSkewMs as invalid rather than disabling the skew check", () => {
    const signature = signServiceRequest({...base, secret: "s1"})
    const verify = (nowMs: number, maxSkewMs: number) =>
      verifyServiceRequest({...base, secrets: ["s1"], signature, nowMs, maxSkewMs})
    expect(verify(1_000, Number.NaN)).toBe(false)
    expect(verify(1_000, -1)).toBe(false)
    expect(verify(1_000, Number.POSITIVE_INFINITY)).toBe(false)
    expect(verify(1_000_000, Number.NaN)).toBe(false)
    expect(verify(1_000, 0)).toBe(true)
    expect(verify(1_001, 0)).toBe(false)
  })

  test("exposes the header names", () => {
    expect(SERVICE_HEADERS).toEqual({
      service: "x-mentra-service",
      timestamp: "x-mentra-service-timestamp",
      signature: "x-mentra-service-signature",
    })
  })
})
