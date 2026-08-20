/// <reference types="bun-types" />

import {afterEach, beforeEach, describe, expect, test} from "bun:test"

import {configure, getUiSeams, resetForTests, start, stop, updateUiSeams} from "../bootstrap"

const auth = {
  getSubjectToken: async () => ({token: "test", type: "supabase" as const}),
}

describe("updateUiSeams", () => {
  beforeEach(() => {
    resetForTests()
  })

  afterEach(async () => {
    await stop()
    resetForTests()
  })

  test("is ignored before configure", () => {
    updateUiSeams({
      scanQr: async () => ({cancelled: true}),
    })
    expect(getUiSeams().scanQr).toBeUndefined()
  })

  test("attaches scanQr after configure, including after start", async () => {
    configure({auth})
    expect(getUiSeams().scanQr).toBeUndefined()

    const scanQr = async () => ({data: "payload"} as const)
    updateUiSeams({scanQr})
    expect(getUiSeams().scanQr).toBe(scanQr)

    await start()
    const late = async () => ({cancelled: true} as const)
    updateUiSeams({scanQr: late})
    expect(getUiSeams().scanQr).toBe(late)
  })

  test("survives a configure() that is ignored after start", async () => {
    const scanQr = async () => ({cancelled: true} as const)
    configure({auth, ui: {scanQr}})
    await start()
    configure({auth, ui: {}})
    expect(getUiSeams().scanQr).toBe(scanQr)
  })
})
