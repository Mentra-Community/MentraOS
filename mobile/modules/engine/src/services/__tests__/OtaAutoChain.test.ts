import {beforeEach, describe, expect, test} from "bun:test"

import {beginOtaAutoChain, otaAutoChainReleaseRange, stopOtaAutoChain, tryAdvanceOtaAutoChain} from "../OtaAutoChain"

describe("OtaAutoChain release range", () => {
  beforeEach(() => stopOtaAutoChain())

  test("retains the source and advances the target across OTA passes", () => {
    beginOtaAutoChain("first", false, {
      fromVersion: "3.0.0",
      toVersion: "3.1.0-dev.4",
      releaseVersion: "3.1.0-dev.4",
    })

    expect(otaAutoChainReleaseRange()).toEqual({
      fromVersion: "3.0.0",
      toVersion: "3.1.0-dev.4",
      releaseVersion: "3.1.0-dev.4",
    })
    expect(tryAdvanceOtaAutoChain("second", false, "3.2.0-beta.2", "3.2.0-beta.2")).toEqual({
      advance: true,
      passCount: 2,
    })
    expect(otaAutoChainReleaseRange()).toEqual({
      fromVersion: "3.0.0",
      toVersion: "3.2.0-beta.2",
      releaseVersion: "3.2.0-beta.2",
    })
  })

  test("clears the range with the rest of the session", () => {
    beginOtaAutoChain("first", false, {fromVersion: "3.0.0", toVersion: "3.1.0"})
    stopOtaAutoChain()
    expect(otaAutoChainReleaseRange()).toBeNull()
  })
})
