import type {Device} from "@mentra/bluetooth-sdk"
import {
  MentraLivePairingPages,
  type MentraLivePairingController,
  type MentraLivePairingState,
} from "@mentra/engine/pairing"
import {fireEvent, render} from "@testing-library/react-native"
import {View} from "react-native"

const device = {id: "a", name: "MENTRA_LIVE_BLE_E511", model: "Mentra Live", address: "a"} as Device

function controllerFor(state: MentraLivePairingState): MentraLivePairingController {
  return {
    state,
    continueToScan: jest.fn(),
    scanAgain: jest.fn(),
    select: jest.fn(),
    back: jest.fn(),
    cancelPairing: jest.fn(() => Promise.resolve(true)),
    openBluetoothSettings: jest.fn(),
    finish: jest.fn(),
    retry: jest.fn(),
    exit: jest.fn(),
  }
}

const renderPage = (
  state: MentraLivePairingState,
  props: Partial<Parameters<typeof MentraLivePairingPages>[0]> = {},
) => {
  const controller = controllerFor(state)
  return {controller, ...render(<MentraLivePairingPages controller={controller} {...props} />)}
}

describe("the stock Mentra Live pairing pages", () => {
  it("shows the Power on step with Continue", () => {
    const {controller, getByText} = renderPage({page: "prep"})
    expect(getByText("Power on")).toBeTruthy()
    fireEvent.press(getByText("Continue"))
    expect(controller.continueToScan).toHaveBeenCalled()
  })

  it("lists glasses as Mentra Live rows under the pairing-mode hint", () => {
    const {controller, getByText, getByLabelText} = renderPage({
      page: "scan",
      status: "choosing",
      scanning: true,
      glasses: [{id: "a", label: "E511", device}],
    })
    expect(getByText("Choose your glasses")).toBeTruthy()
    expect(getByText("Press the power button 3 times to enter pairing mode.")).toBeTruthy()
    fireEvent.press(getByLabelText("Mentra Live, E511"))
    expect(controller.select).toHaveBeenCalled()
  })

  it("offers Try Again after a scan stopped, and Scan Again when nothing was found", () => {
    const stopped = renderPage({
      page: "scan",
      status: "in_use",
      scanning: false,
      glasses: [],
    })
    expect(stopped.getByText("Glasses may be in use")).toBeTruthy()
    fireEvent.press(stopped.getByText("Try Again"))
    expect(stopped.controller.scanAgain).toHaveBeenCalled()
    stopped.unmount()

    const empty = renderPage({
      page: "scan",
      status: "not_found",
      scanning: false,
      glasses: [],
    })
    expect(empty.getByText("Not showing up?")).toBeTruthy()
    expect(empty.getByText("Scan Again")).toBeTruthy()
  })

  it("shows the connecting card with Cancel", () => {
    const {controller, getByText} = renderPage({page: "connecting", device, booting: true})
    expect(getByText("Pairing")).toBeTruthy()
    expect(getByText("Glasses are booting up…")).toBeTruthy()
    fireEvent.press(getByText("Cancel"))
    expect(controller.back).toHaveBeenCalled()
  })

  it("asks before cancelling from Pair Audio", () => {
    const showAlert = jest.fn()
    const {controller, getByText, getByLabelText} = renderPage(
      {page: "pair_audio", deviceName: "MENTRA_LIVE_BLE_E511", canCancel: true, otherAudioConnected: false},
      {showAlert},
    )
    expect(getByText("Pair Audio")).toBeTruthy()
    expect(getByText('Tap "MENTRA_LIVE_BLE_E511" under My Devices or Other Devices')).toBeTruthy()
    fireEvent.press(getByText("Open Settings"))
    expect(controller.openBluetoothSettings).toHaveBeenCalled()
    fireEvent.press(getByLabelText("Cancel pairing"))
    expect(showAlert).toHaveBeenCalledWith("Cancel pairing?", expect.any(String), expect.any(Array))
    expect(controller.cancelPairing).not.toHaveBeenCalled()
  })

  it("names the glasses with spaces on the forget page", () => {
    const {getByText} = renderPage({page: "forget_ios_pairing", deviceName: "Mentra_Live_E511"})
    expect(getByText("Tap ⓘ next to Mentra Live E511, then tap Forget This Device.")).toBeTruthy()
  })

  it("says Mentra Live connected and Continue setup when the host has more setup", () => {
    const {controller, getByText} = renderPage({page: "success"}, {setupRemaining: true})
    expect(getByText("Mentra Live connected")).toBeTruthy()
    fireEvent.press(getByText("Continue setup"))
    expect(controller.finish).toHaveBeenCalled()
  })

  it("shows the failure in the host's words", () => {
    const {getByText} = renderPage(
      {page: "failure", error: "errors:pairingCouldNotStart"},
      {translate: (key, options) => `${key}${options?.glassesModel ? `:${options.glassesModel}` : ""}`},
    )
    expect(getByText("pairing:pairingFailed")).toBeTruthy()
    expect(getByText("errors:pairingCouldNotStart:Mentra Live")).toBeTruthy()
  })

  it("lets a host replace one page and keeps the others stock", () => {
    const pages = {success: () => <View testID="custom-success" />}
    const custom = renderPage({page: "success"}, {pages})
    expect(custom.getByTestId("custom-success")).toBeTruthy()
    custom.unmount()
    expect(renderPage({page: "prep"}, {pages}).getByText("Power on")).toBeTruthy()
  })
})
