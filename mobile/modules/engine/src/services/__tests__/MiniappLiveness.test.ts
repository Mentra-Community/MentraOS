/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {advanceMiniappPingLiveness, shouldHoldMiniappPingLiveness} from "../MiniappLiveness"

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

describe("shouldHoldMiniappPingLiveness", () => {
  test("holds while this miniapp has an in-flight SoftAP join", () => {
    expect(
      shouldHoldMiniappPingLiveness({
        packageName: "com.mentra.call",
        softapPackageName: "com.mentra.call",
        softapCancelled: false,
        softapJoining: true,
      }),
    ).toBe(true)
  })

  test("does not hold once the SoftAP call is live", () => {
    expect(
      shouldHoldMiniappPingLiveness({
        packageName: "com.mentra.call",
        softapPackageName: "com.mentra.call",
        softapCancelled: false,
        softapJoining: false,
      }),
    ).toBe(false)
  })

  test("does not hold after the SoftAP join is cancelled", () => {
    expect(
      shouldHoldMiniappPingLiveness({
        packageName: "com.mentra.call",
        softapPackageName: "com.mentra.call",
        softapCancelled: true,
        softapJoining: true,
      }),
    ).toBe(false)
  })

  test("does not hold a different miniapp or when no SoftAP join is running", () => {
    expect(
      shouldHoldMiniappPingLiveness({
        packageName: "com.mentra.call",
        softapPackageName: "com.mentra.notes",
        softapCancelled: false,
        softapJoining: true,
      }),
    ).toBe(false)
    expect(
      shouldHoldMiniappPingLiveness({
        packageName: "com.mentra.call",
      }),
    ).toBe(false)
  })
})
