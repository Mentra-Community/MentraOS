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
        (validate, retry) => acquireManagedLiveOwner(validate, retry, target.deviceId),
        async (options) => {
          const native = await BluetoothSdk.getFirmwareUpdateSnapshot(target.deviceId).catch((error: unknown) => {
            // Older standalone SDK hosts may not expose the additive native observation API.
            if ((error as {code?: string})?.code === "unsupported") return null
            throw error
          })
          if (!native || native.safeToRelease) return false
          if (options.initializeRuntime !== false) await liveOtaPorts.initialize()
          // Reconciliation may observe a completed/idle transaction. It never restores chain approval.
          const status = await BluetoothSdk.queryOtaStatus()
          const device = await BluetoothSdk.getDefaultDevice()
          if (device?.id !== target.deviceId)
            throw new FirmwareUpdateError("stale_offer", "The paired glasses changed during recovery")
          return status.status !== "idle" && status.status !== "complete" && status.status !== "failed"
        },
      ),
  },
}
