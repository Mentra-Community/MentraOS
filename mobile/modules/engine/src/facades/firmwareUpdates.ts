import BluetoothSdk from "@mentra/bluetooth-sdk"
import {deviceIntegrations} from "../devices/builtins"
import {FirmwareUpdateService} from "../ota/UpdateService"
import {FirmwareUpdateError, type FirmwareEntryPoint, type FirmwareTarget} from "../ota/types"
import {observeNativeRecovery} from "../ota/observeNativeRecovery"

export const firmwareUpdateService = new FirmwareUpdateService(deviceIntegrations)

async function currentTarget(): Promise<FirmwareTarget> {
  const device = await BluetoothSdk.getDefaultDevice()
  if (!device) throw new FirmwareUpdateError("unsupported", "No paired device is available")
  const integration = deviceIntegrations.forModel(device.model)
  if (!integration?.firmware) throw new FirmwareUpdateError("unsupported", "This device has no firmware updater")
  return {integrationId: integration.id, deviceId: device.id, displayName: device.model}
}

export const firmwareUpdates = {
  currentTarget,
  observeNativeRecovery(listener: Parameters<typeof observeNativeRecovery>[0]) {
    return observeNativeRecovery((snapshot) => {
      if (snapshot) firmwareUpdateService.noteNativeRecovery(snapshot, snapshot.safeToRelease)
      listener(snapshot)
    })
  },
  pairingPolicy(model: string) {
    const integration = deviceIntegrations.forModel(model)
    return {
      checkFirmware:
        (integration?.firmware?.isEnabled?.() ?? true) &&
        (integration?.firmware?.entryPoints.includes("pairing") ?? false),
      requiresBluetoothClassic: integration?.setup?.requiresBluetoothClassic ?? false,
      checkFirmwareAfterWifi: integration?.setup?.checkFirmwareAfterWifi ?? false,
      onboardingFlowId: integration?.setup?.onboardingFlowId ?? null,
      includeOsOnboarding: integration?.setup?.includeOsOnboarding ?? true,
    }
  },
  supports(model: string, entryPoint: FirmwareEntryPoint): boolean {
    const firmware = deviceIntegrations.forModel(model)?.firmware
    return (firmware?.isEnabled?.() ?? true) && (firmware?.entryPoints.includes(entryPoint) ?? false)
  },
  open: firmwareUpdateService.open.bind(firmwareUpdateService),
  snapshot: firmwareUpdateService.snapshot.bind(firmwareUpdateService),
  subscribe: firmwareUpdateService.subscribe.bind(firmwareUpdateService),
  retainedSnapshots: firmwareUpdateService.retainedSnapshots,
  subscribeRetained: firmwareUpdateService.subscribeRetained,
  perform: firmwareUpdateService.perform.bind(firmwareUpdateService),
  assertSafeToRelease: firmwareUpdateService.assertSafeToRelease.bind(firmwareUpdateService),
  suspendNewWork: firmwareUpdateService.suspendNewWork.bind(firmwareUpdateService),
  diagnosticSnapshot: firmwareUpdateService.diagnosticSnapshot.bind(firmwareUpdateService),
}
