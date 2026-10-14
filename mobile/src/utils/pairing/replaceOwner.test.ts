import {
  classifyReplaceOwnerResult,
  REPLACE_OWNER_ERROR_TX,
  REPLACE_OWNER_ROUTE,
  shouldRouteToReplaceOwner,
} from "./replaceOwner"

describe("shouldRouteToReplaceOwner", () => {
  const base = {platformSupported: true, awaitingConfirm: true, securePairing: true}

  it("routes only when the platform gate, secure pairing and awaiting_confirm all hold", () => {
    expect(shouldRouteToReplaceOwner(base)).toBe(true)
    expect(shouldRouteToReplaceOwner({...base, platformSupported: false})).toBe(false)
    expect(shouldRouteToReplaceOwner({...base, securePairing: false})).toBe(false)
  })

  it("treats a false or absent awaiting_confirm as today's flow", () => {
    expect(shouldRouteToReplaceOwner({...base, awaitingConfirm: false})).toBe(false)
    expect(shouldRouteToReplaceOwner({...base, awaitingConfirm: undefined})).toBe(false)
  })

  it("does not accept truthy non-booleans", () => {
    expect(shouldRouteToReplaceOwner({...base, awaitingConfirm: "true" as unknown as boolean})).toBe(false)
  })
})

describe("classifyReplaceOwnerResult", () => {
  it("continues on success", () => {
    expect(classifyReplaceOwnerResult({ok: true})).toEqual({kind: "continue"})
  })

  it("continues when there was no owner left to replace", () => {
    expect(classifyReplaceOwnerResult({ok: false, reason: "no_owner"})).toEqual({kind: "continue"})
  })

  it("maps refusals to reason-specific errors", () => {
    expect(classifyReplaceOwnerResult({ok: false, reason: "not_pairing"})).toEqual({
      kind: "error",
      error: "not_pairing",
    })
    expect(classifyReplaceOwnerResult({ok: false, reason: "wipe_failed"})).toEqual({
      kind: "error",
      error: "wipe_failed",
    })
  })

  it("maps unknown or missing reasons to a generic failure", () => {
    expect(classifyReplaceOwnerResult({ok: false, reason: "something_new"})).toEqual({kind: "error", error: "failed"})
    expect(classifyReplaceOwnerResult({ok: false})).toEqual({kind: "error", error: "failed"})
  })

  it("has a message for every error", () => {
    expect(Object.keys(REPLACE_OWNER_ERROR_TX).sort()).toEqual(["failed", "not_pairing", "timeout", "wipe_failed"])
  })
})

describe("replace owner route", () => {
  it("matches the file-based route", () => {
    expect(REPLACE_OWNER_ROUTE).toBe("/pairing/replace-owner")
  })
})
