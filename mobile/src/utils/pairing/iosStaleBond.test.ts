import {iosBluetoothDeviceLabel, isIosForgetPairingFailure} from "./iosStaleBond"

describe("iosBluetoothDeviceLabel", () => {
  it("keeps the glasses code as its own word so the line cannot clip it off", () => {
    expect(iosBluetoothDeviceLabel("Mentra_Live_E511", "Mentra Live")).toBe("Mentra Live E511")
  })

  it("falls back when the route did not pass a name", () => {
    expect(iosBluetoothDeviceLabel(undefined, "Mentra Live")).toBe("Mentra Live")
    expect(iosBluetoothDeviceLabel("  ", "Mentra Live")).toBe("Mentra Live")
  })
})

describe("isIosForgetPairingFailure", () => {
  it("matches only the ios_forget_pairing code on iOS", () => {
    expect(isIosForgetPairingFailure({code: "ios_forget_pairing"}, "ios")).toBe(true)
    expect(isIosForgetPairingFailure({code: "ios_forget_pairing"}, "android")).toBe(false)
    expect(isIosForgetPairingFailure({code: "other"}, "ios")).toBe(false)
    expect(isIosForgetPairingFailure({}, "ios")).toBe(false)
  })
})
