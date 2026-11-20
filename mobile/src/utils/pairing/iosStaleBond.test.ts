import {DeviceTypes} from "@mentra/engine"

import {askToForgetIosPairing, FORGET_IOS_PAIRING_ROUTE} from "./iosStaleBond"

describe("askToForgetIosPairing", () => {
  it("sends an iPhone to Settings after unpairing glasses that delete its keys", () => {
    expect(askToForgetIosPairing("ios", DeviceTypes.LIVE, "Mentra_Live_1234", "home", false)).toEqual({
      route: FORGET_IOS_PAIRING_ROUTE,
      params: {deviceModel: DeviceTypes.LIVE, deviceName: "Mentra_Live_1234", then: "home"},
    })
  })

  it("keeps the iPhone's pairing when the glasses keep former owners' keys", () => {
    expect(askToForgetIosPairing("ios", DeviceTypes.LIVE, "Mentra_Live_1234", "sign-in", true)).toBeNull()
  })

  it("never asks on Android, which removes or keeps the bond itself", () => {
    expect(askToForgetIosPairing("android", DeviceTypes.LIVE, "Mentra_Live_1234", "home", false)).toBeNull()
  })
})
