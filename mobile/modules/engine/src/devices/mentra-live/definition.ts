import BluetoothSdk from "@mentra/bluetooth-sdk"
import type {DeviceIntegration} from "../types"
import {FirmwareUpdateError} from "../../ota/types"
import {otaInstallCoordinator} from "../../services/OtaInstallCoordinator"
import {acquireManagedLiveOwner} from "./ownership"
import {liveOtaPorts} from "./ports"
import {MentraLiveFirmwareProvider} from "./provider"

export const mentraLiveIntegration: DeviceIntegration = {
  id: "mentra-live",
  models: ["Mentra Live"],
  setup: {requiresBluetoothClassic: true, checkFirmwareAfterWifi: true, onboardingFlowId: "mentra-live"},
  firmware: {
    entryPoints: ["pairing", "settings", "background", "recovery"],
    createProvider: (target) =>
      new MentraLiveFirmwareProvider(
        target,
        liveOtaPorts,
        async () => {
          const device = await BluetoothSdk.getDefaultDevice()
          if (!device || device.id !== target.deviceId || !mentraLiveIntegration.models.includes(device.model)) {
            throw new FirmwareUpdateError("stale_offer", "The paired glasses changed; reopen the update flow")
          }
        },
        () => otaInstallCoordinator.isSafeToRelease(),
        acquireManagedLiveOwner,
      ),
  },
}
