/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {resolveHiddenStatus} from "../appVisibility"

describe("resolveHiddenStatus", () => {
  test("keeps registry-hidden apps off the home screen", () => {
    expect(resolveHiddenStatus(true, false)).toBe(true)
  })

  test("preserves a user's persisted hidden state", () => {
    expect(resolveHiddenStatus(false, true)).toBe(true)
  })

  test("shows an app only when neither source hides it", () => {
    expect(resolveHiddenStatus(false, false)).toBe(false)
  })
})
