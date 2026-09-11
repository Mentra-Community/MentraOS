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
})
