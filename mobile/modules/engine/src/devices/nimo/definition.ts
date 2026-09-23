import BluetoothSdk from "@mentra/bluetooth-sdk"
import {DEVICE_FIRMWARE_CATALOGUE, type NativeFirmwareUpdateSnapshot} from "@mentra/bluetooth-sdk/firmware-updates"

import {fetchPinnedFirmwareManifest, stageFirmwareArtifact} from "../../ota/FirmwareArtifacts"
import {acquireFirmwareRuntime} from "../../ota/RuntimeLease"
import {resolveFirmwareSource} from "../../ota/sourcePolicy"
import {FirmwareUpdateError, type FirmwareTarget} from "../../ota/types"
import {getConfigValues} from "../../runtime/bootstrap"
import {BgTimer} from "../../utils/timers"
import type {DeviceIntegration} from "../types"
import {parseNimoManifest} from "./manifest"
import {NimoFirmwareProvider, type NimoFirmwarePorts} from "./provider"

function portsFor(target: FirmwareTarget): NimoFirmwarePorts {
  const validateTarget = async () => {
    const device = await BluetoothSdk.getDefaultDevice()
    if (!device || device.id !== target.deviceId || !nimoIntegration.models.includes(device.model))
      throw new FirmwareUpdateError("stale_offer", "The paired NIMO changed; reopen the update flow")
  }
  const read = () => BluetoothSdk.getFirmwareUpdateSnapshot(target.deviceId)
  const listen = (listener: (value: NativeFirmwareUpdateSnapshot) => void) => {
    const subscription = BluetoothSdk.addListener("firmware_update", listener)
    return () => subscription.remove()
  }
  return {
    read,
    listen,
    validateTarget,
    refreshInventory: async () => {
      await validateTarget()
      const before = await read()
      if (!before.safeToRelease || before.sessionId) return before
      return new Promise<NativeFirmwareUpdateSnapshot>((resolve, reject) => {
        let settled = false
        const finish = (value: NativeFirmwareUpdateSnapshot | null, error?: unknown) => {
          if (settled) return
          settled = true
          remove()
          BgTimer.clearTimeout(timeout)
          if (value) resolve(value)
          else reject(error)
        }
        const remove = listen((value) => {
          if (value.deviceId !== target.deviceId || value.integrationId !== target.integrationId) return
          if (value.updaterId !== before.updaterId || value.connectionGeneration !== before.connectionGeneration) {
            finish(null, new FirmwareUpdateError("stale_offer", "NIMO reconnected during the firmware check"))
          } else if (Number(value.inventory.revision ?? 0) > Number(before.inventory.revision ?? 0)) finish(value)
        })
        const timeout = BgTimer.setTimeout(
          () => finish(null, new Error("NIMO did not return its current firmware version")),
          17000,
        )
        void BluetoothSdk.reconcileFirmwareUpdate(target.deviceId).then(
          (value) => {
            if (!value.safeToRelease || value.sessionId) finish(value)
          },
          (error) => finish(null, error),
        )
      })
    },
    reconcile: () => BluetoothSdk.reconcileFirmwareUpdate(target.deviceId),
    start: (request) => BluetoothSdk.startFirmwareUpdate(request),
    acknowledge: () => BluetoothSdk.acknowledgeFirmwareUpdate(target.deviceId),
    source: () =>
      resolveFirmwareSource("nimo", getConfigValues().firmwareSources, DEVICE_FIRMWARE_CATALOGUE.nimo.manifest),
    loadManifest: async (pin) => parseNimoManifest(await fetchPinnedFirmwareManifest(pin)),
    compatible: DEVICE_FIRMWARE_CATALOGUE.nimo.compatible,
    stage: (manifest, progress) => stageFirmwareArtifact(manifest.artifact, progress),
    acquireRuntime: acquireFirmwareRuntime,
    id: () => `nimo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  }
}

export const nimoIntegration: DeviceIntegration = {
  id: "nimo",
  models: ["NIMO"],
  firmware: {
    entryPoints: ["pairing", "settings", "recovery"],
    createProvider: (target) => new NimoFirmwareProvider(target, portsFor(target)),
  },
}
