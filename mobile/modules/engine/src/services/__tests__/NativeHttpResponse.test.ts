/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {nativeHttpResponseBody} from "../NativeHttpResponse"

describe("nativeHttpResponseBody", () => {
  test.each([204, 205, 304])("uses a null body for status %d", (status) => {
    expect(nativeHttpResponseBody(status, "")).toBeNull()
  })

  test("preserves response bodies for ordinary statuses", () => {
    expect(nativeHttpResponseBody(200, "ok")).toBe("ok")
    expect(nativeHttpResponseBody(404, "missing")).toBe("missing")
  })
})
