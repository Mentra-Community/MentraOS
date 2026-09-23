import * as RNFS from "@dr.pogodin/react-native-fs"
import BluetoothSdk from "@mentra/bluetooth-sdk"
import type {NativeFirmwareUpdateSnapshot} from "@mentra/bluetooth-sdk/firmware-updates"
import {stageFirmwareArtifact} from "../../ota/FirmwareArtifacts"
import {acquireFirmwareRuntime} from "../../ota/RuntimeLease"
import {FirmwareUpdateError, type FirmwareTarget} from "../../ota/types"
import {getConfigValues} from "../../runtime/bootstrap"
import {BgTimer} from "../../utils/timers"
import type {DeviceIntegration} from "../types"
import {Ar99FirmwareProvider, type Ar99FirmwarePorts} from "./provider"
import {AR99_OTA_HEADERS, checkAr99Release, parseAr99Source} from "./releaseSource"

function portsFor(target: FirmwareTarget): Ar99FirmwarePorts {
  const validateTarget = async () => {
    const device = await BluetoothSdk.getDefaultDevice()
    if (!device || device.id !== target.deviceId || !ar99Integration.models.includes(device.model))
      throw new FirmwareUpdateError("stale_offer", "The paired AR99 changed; reopen this flow")
  }
  const read = () => BluetoothSdk.getFirmwareUpdateSnapshot(target.deviceId)
  const listen = (listener: (value: NativeFirmwareUpdateSnapshot) => void) => {
    const subscription = BluetoothSdk.addListener("firmware_update", listener)
    return () => subscription.remove()
  }
  return {
    validateTarget,
    read,
    listen,
    refreshInventory: async () => {
      await validateTarget()
      const before = await read()
      if (!before.safeToRelease || before.sessionId) return before
      return new Promise((resolve, reject) => {
        let settled = false
        const finish = (value: NativeFirmwareUpdateSnapshot | null, error?: unknown) => {
          if (settled) return
          settled = true
          remove()
          BgTimer.clearTimeout(timer)
          if (value) resolve(value)
          else reject(error)
        }
        const remove = listen((value) => {
          if (value.deviceId !== target.deviceId || value.integrationId !== target.integrationId) return
          if (value.updaterId !== before.updaterId || value.connectionGeneration !== before.connectionGeneration)
            finish(null, new Error("AR99 reconnected during the version check"))
          else if (Number(value.inventory.revision ?? 0) > Number(before.inventory.revision ?? 0)) finish(value)
        })
        const timer = BgTimer.setTimeout(() => finish(null, new Error("AR99 device information is not ready")), 17000)
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
    source: () => {
      const policy = getConfigValues().firmwareSources
      if (policy?.allowBundled === false || policy?.sources?.ar99 === null) return null
      return parseAr99Source(policy?.vendorSources?.ar99)
    },
    lookup: (source, native) =>
      checkAr99Release(
        source,
        native.observedFirmware ?? "",
        native.inventory.serialNumber ?? "",
        native.inventory.projectName ?? "AR99",
        {
          fetch: (...args) => fetch(...args),
          sign: (...args) => BluetoothSdk.buildAr99OtaSignature(...args),
          nonce: () => Math.floor(Math.random() * 2147483647).toString(),
        },
      ),
    stage: async (release, progress) => {
      const file = await stageFirmwareArtifact(
        {url: release.firmwareUrl, md5: release.fileMd5 || undefined, headers: AR99_OTA_HEADERS},
        progress,
      )
      try {
        const size = Number((await RNFS.stat(file.path)).size)
        if (size < 1 || size > 64 * 1024 * 1024) throw new Error("AR99 firmware file exceeds the native transfer limit")
        return {
          artifact: {
            path: file.path,
            targetVersion: release.currentVersion,
            size,
            sha256: await RNFS.hash(file.path, "sha256"),
          },
          release: file.release,
        }
      } catch (error) {
        await file.release()
        throw error
      }
    },
    acquireRuntime: acquireFirmwareRuntime,
    id: () => `ar99-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  }
}

export const ar99Integration: DeviceIntegration = {
  id: "ar99",
  models: ["AR99"],
  setup: {includeOsOnboarding: false},
  firmware: {
    entryPoints: ["settings", "recovery"],
    createProvider: (target) => new Ar99FirmwareProvider(target, portsFor(target)),
  },
}
