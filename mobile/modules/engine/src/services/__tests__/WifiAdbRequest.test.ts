/// <reference types="bun-types" />

import {describe, expect, mock, test} from "bun:test"

import {MiniappErrorCode} from "../../../../miniapp/src/protocol"
import {handleWifiAdbRequest} from "../WifiAdbRequest"

function buildDependencies(allowedPackages: string[], failure?: unknown) {
  const isSystemPackage = mock((packageName: string) => allowedPackages.includes(packageName))
  const setWifiAdbState = mock(async (_enabled: boolean) => {
    if (failure !== undefined) throw failure
  })

  return {
    dependencies: {isSystemPackage, setWifiAdbState},
    isSystemPackage,
    setWifiAdbState,
  }
}

describe("handleWifiAdbRequest", () => {
  test("rejects a non-system miniapp without calling BluetoothSdk", async () => {
    const {dependencies, setWifiAdbState} = buildDependencies([])

    const result = await handleWifiAdbRequest("com.example.thirdparty", {enabled: true}, dependencies)

    expect(result).toEqual({
      ok: false,
      error: {
        code: MiniappErrorCode.NOT_PERMITTED,
        message: "setWifiAdbState is restricted to system apps",
      },
    })
    expect(setWifiAdbState).not.toHaveBeenCalled()
  })

  test.each(["com.mentra.settings", "com.example.miniapp-dev"])(
    "forwards an allowed SYSTEM/miniapp-dev caller (%s) to BluetoothSdk",
    async (packageName) => {
      const {dependencies, setWifiAdbState} = buildDependencies([packageName])

      const result = await handleWifiAdbRequest(packageName, {enabled: false}, dependencies)

      expect(result).toEqual({ok: true})
      expect(setWifiAdbState).toHaveBeenCalledTimes(1)
      expect(setWifiAdbState).toHaveBeenCalledWith(false)
    },
  )

  test("rejects an invalid enabled value before calling BluetoothSdk", async () => {
    const {dependencies, setWifiAdbState} = buildDependencies(["com.mentra.settings"])

    const result = await handleWifiAdbRequest("com.mentra.settings", {enabled: "yes"}, dependencies)

    expect(result).toEqual({
      ok: false,
      error: {
        code: MiniappErrorCode.INVALID_ARGUMENT,
        message: "enabled must be a boolean",
      },
    })
    expect(setWifiAdbState).not.toHaveBeenCalled()
  })

  test("maps BluetoothSdk failures to INTERNAL", async () => {
    const {dependencies} = buildDependencies(["com.mentra.settings"], new Error("glasses disconnected"))

    const result = await handleWifiAdbRequest("com.mentra.settings", {enabled: true}, dependencies)

    expect(result).toEqual({
      ok: false,
      error: {
        code: MiniappErrorCode.INTERNAL,
        message: "glasses disconnected",
      },
    })
  })
})
