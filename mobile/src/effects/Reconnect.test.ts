import BluetoothSdk from "@mentra/bluetooth-sdk-internal"
import {toolkit} from "@mentra/island"

import {attemptReconnectToDefaultWearable} from "@/effects/Reconnect"
import {useCoreStore} from "@/stores/core"
import {useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSettingsStore} from "@/stores/settings"
import {resetBluetoothSdkMock} from "@/test-utils/mockBluetoothSdk"

jest.mock("@/utils/PermissionsUtils", () => ({
  checkConnectivityRequirementsUI: jest.fn(() => Promise.resolve(true)),
}))

describe("attemptReconnectToDefaultWearable", () => {
  beforeEach(() => {
    resetBluetoothSdkMock()
    useCoreStore.getState().reset()
    useGlassesStore.getState().reset()
    useSettingsStore.getState().resetAllSettingsLocally()
  })

  it("syncs Manager Bluetooth settings before reconnecting default glasses", async () => {
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        [SETTINGS.default_wearable.key]: "Mentra Live",
      },
    }))

    await expect(attemptReconnectToDefaultWearable()).resolves.toBe(true)

    expect(BluetoothSdk.updateBluetoothSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        voice_activity_detection_enabled: true,
      }),
    )
    // connectDefault now routes through the island facade (toolkit.glasses), while
    // the settings seed still calls BluetoothSdk directly — assert the seed lands first.
    expect(toolkit.glasses.connectDefault).toHaveBeenCalled()
    expect((BluetoothSdk.updateBluetoothSettings as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (toolkit.glasses.connectDefault as jest.Mock).mock.invocationCallOrder[0],
    )
  })
})
