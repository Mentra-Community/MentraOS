// Imports the real PairingCoordinator by path (not via "@mentra/island", which
// jest mocks) so the actual decisions run under the mobile jest CI runner.
import {buildPairingRouteStack, classifyPairFailure} from "../../modules/island/src/services/PairingCoordinator"

describe("classifyPairFailure", () => {
  it("routes the Even Realities disconnect error to unpair-even", () => {
    expect(classifyPairFailure("errors:pairNeedDisconnect")).toBe("unpair-even")
  })

  it("routes every other error to the failure screen", () => {
    expect(classifyPairFailure("errors:timeout")).toBe("failure")
    expect(classifyPairFailure("")).toBe("failure")
  })
})

describe("buildPairingRouteStack", () => {
  it("returns an empty stack for non-OTA glasses", () => {
    expect(buildPairingRouteStack({hasOta: false, isAndroid: false, bluetoothClassicConnected: false})).toEqual([])
  })

  it("includes the BT-Classic step then OTA when not yet BT-Classic connected (iOS)", () => {
    expect(buildPairingRouteStack({hasOta: true, isAndroid: false, bluetoothClassicConnected: false})).toEqual([
      "/pairing/btclassic",
      "/ota/check-for-updates",
    ])
  })

  it("skips BT-Classic on Android (paired at the native stack level)", () => {
    expect(buildPairingRouteStack({hasOta: true, isAndroid: true, bluetoothClassicConnected: false})).toEqual([
      "/ota/check-for-updates",
    ])
  })

  it("skips BT-Classic when already connected", () => {
    expect(buildPairingRouteStack({hasOta: true, isAndroid: false, bluetoothClassicConnected: true})).toEqual([
      "/ota/check-for-updates",
    ])
  })
})
