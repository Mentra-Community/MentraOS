/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {advanceMiniappPingLiveness} from "../MiniappLiveness"

describe("advanceMiniappPingLiveness", () => {
  test("counts a ping round that has not answered yet", () => {
    expect(advanceMiniappPingLiveness(0, 6)).toEqual({
      shouldUnregister: false,
      unansweredPingRounds: 1,
    })
  })

  test("allows the configured number of actual ping attempts", () => {
    expect(advanceMiniappPingLiveness(5, 6)).toEqual({
      shouldUnregister: false,
      unansweredPingRounds: 6,
    })
  })

  test("unregisters only after the configured attempts went unanswered", () => {
    expect(advanceMiniappPingLiveness(6, 6)).toEqual({
      shouldUnregister: true,
      unansweredPingRounds: 6,
    })
  })
})
