import {engine} from "@mentra/engine"

import {attemptReconnectToDefaultWearable} from "@/effects/Reconnect"
import {useCoreStore} from "@mentra/engine-host-internal"
import {useGlassesStore} from "../../modules/engine/src/stores/glasses"
import {SETTINGS} from "@mentra/engine"
import {useSettingsStore} from "@mentra/engine-host-internal"
import {resetBluetoothSdkMock} from "@/test-utils/mockBluetoothSdk"

jest.mock("@/utils/PermissionsUtils", () => ({
  checkConnectivityRequirementsUI: jest.fn(() => Promise.resolve(true)),
}))

describe("attemptReconnectToDefaultWearable", () => {
  beforeEach(() => {
    resetBluetoothSdkMock()
    ;(engine.glasses.connectDefault as jest.Mock).mockClear()
    useCoreStore.getState().reset()
    useGlassesStore.getState().reset()
    useSettingsStore.getState().resetAllSettingsLocally()
  })

  it("reconnects the default glasses via the island facade", async () => {
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        [SETTINGS.default_wearable.key]: "Mentra Live",
      },
    }))

    await expect(attemptReconnectToDefaultWearable()).resolves.toBe(true)

    // The pre-connect settings seed moved into engine.glasses.connectDefault();
    // the host just delegates the reconnect now (seed behavior is covered in
    // glassesFacade.test.ts where the real facade runs).
    expect(engine.glasses.connectDefault).toHaveBeenCalled()
  })

  // The jest.setup engine mock carries a simplified decideReconnect. Route these cases through the real
  // decision so the host wiring (SDK pairing state in, skip out) is what is asserted.
  describe("with the real reconnect decision", () => {
    let decideSpy: jest.SpyInstance

    beforeEach(() => {
      const actual = jest.requireActual("../../modules/engine/src/services/ConnectionCoordinator")
      decideSpy = jest.spyOn(require("@mentra/engine"), "decideReconnect").mockImplementation(actual.decideReconnect)
    })

    afterEach(() => {
      decideSpy.mockRestore()
    })

    it("does not reconnect after the SDK reports pairing_rejected", async () => {
      useSettingsStore.setState((state) => ({
        settings: {...state.settings, [SETTINGS.default_wearable.key]: "Mentra Live"},
      }))
      ;(engine.glasses.status as jest.Mock).mockReturnValueOnce({
        state: "disconnected",
        pairingState: {state: "pairing_rejected"},
      })

      await expect(attemptReconnectToDefaultWearable()).resolves.toBe(true)

      expect(engine.glasses.connectDefault).not.toHaveBeenCalled()
    })

    it("does not reconnect while the pairing window is open, then reconnects once it is normal again", async () => {
      useSettingsStore.setState((state) => ({
        settings: {...state.settings, [SETTINGS.default_wearable.key]: "Mentra Live"},
      }))
      ;(engine.glasses.status as jest.Mock).mockReturnValueOnce({
        state: "disconnected",
        pairingState: {state: "pairing_mode", windowId: 3, endsAtMs: Date.now() + 60_000},
      })
      await expect(attemptReconnectToDefaultWearable()).resolves.toBe(true)
      expect(engine.glasses.connectDefault).not.toHaveBeenCalled()
      ;(engine.glasses.status as jest.Mock).mockReturnValueOnce({
        state: "disconnected",
        pairingState: {state: "normal"},
      })
      await expect(attemptReconnectToDefaultWearable()).resolves.toBe(true)
      expect(engine.glasses.connectDefault).toHaveBeenCalledTimes(1)
    })
  })
})
