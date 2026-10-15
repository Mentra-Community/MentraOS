import {
  classicWaitState,
  classifyReplaceOwnerResult,
  REPLACE_OWNER_ERROR_TX,
  REPLACE_OWNER_ROUTE,
  shouldPairClassicAfterBle,
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

  it("does not ask the phone that already owns the glasses", () => {
    expect(shouldRouteToReplaceOwner({...base, retainedOwnerLink: true})).toBe(false)
  })
})

describe("shouldPairClassicAfterBle", () => {
  it("sends iOS Mentra Live to Settings only when Classic audio is still down", () => {
    expect(
      shouldPairClassicAfterBle({
        platform: "ios",
        deviceModel: "Mentra Live",
        bluetoothClassicConnected: false,
      }),
    ).toBe(true)
    expect(
      shouldPairClassicAfterBle({
        platform: "ios",
        deviceModel: "Mentra Live",
        bluetoothClassicConnected: true,
      }),
    ).toBe(false)
    expect(
      shouldPairClassicAfterBle({
        platform: "android",
        deviceModel: "Mentra Live",
        bluetoothClassicConnected: false,
      }),
    ).toBe(false)
    expect(
      shouldPairClassicAfterBle({
        platform: "ios",
        deviceModel: "Even Realities G1",
        bluetoothClassicConnected: false,
      }),
    ).toBe(false)
  })
})

describe("classicWaitState", () => {
  const iosLive = {
    platform: "ios",
    deviceModel: "Mentra Live",
    bluetoothClassicConnected: false,
    bluetoothClassicProfilesConnected: false,
    bluetoothAudioRouted: false,
    settleElapsed: false,
  }

  it("waits on iOS Mentra Live while nothing is up and the settle window is open", () => {
    expect(classicWaitState(iosLive)).toBe("waiting")
  })

  it("falls back to Settings once the settle window passed with nothing up", () => {
    expect(classicWaitState({...iosLive, settleElapsed: true})).toBe("fallback")
  })

  it.each([["bluetoothClassicConnected"], ["bluetoothClassicProfilesConnected"], ["bluetoothAudioRouted"]] as const)(
    "is done as soon as %s is true, before or after the settle window",
    (signal) => {
      expect(classicWaitState({...iosLive, [signal]: true})).toBe("done")
      expect(classicWaitState({...iosLive, [signal]: true, settleElapsed: true})).toBe("done")
    },
  )

  it("is done when all three signals are true", () => {
    expect(
      classicWaitState({
        ...iosLive,
        bluetoothClassicConnected: true,
        bluetoothClassicProfilesConnected: true,
        bluetoothAudioRouted: true,
      }),
    ).toBe("done")
  })

  it.each([
    ["android", "Mentra Live"],
    ["ios", "Even Realities G1"],
    ["ios", "Mentra Display"],
    ["android", "Even Realities G1"],
    ["web", "Mentra Live"],
  ])("never waits for %s %s", (platform, deviceModel) => {
    for (const settleElapsed of [false, true]) {
      expect(classicWaitState({...iosLive, platform, deviceModel, settleElapsed})).toBe("done")
    }
  })

  it("agrees with shouldPairClassicAfterBle when only the bond signal is used", () => {
    for (const bluetoothClassicConnected of [false, true]) {
      for (const platform of ["ios", "android"]) {
        for (const deviceModel of ["Mentra Live", "Even Realities G1"]) {
          expect(classicWaitState({...iosLive, platform, deviceModel, bluetoothClassicConnected}) !== "done").toBe(
            shouldPairClassicAfterBle({platform, deviceModel, bluetoothClassicConnected}),
          )
        }
      }
    }
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
    expect(classifyReplaceOwnerResult({ok: false, reason: "retained_owner"})).toEqual({kind: "yield"})
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
