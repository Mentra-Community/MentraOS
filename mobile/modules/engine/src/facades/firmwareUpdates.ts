import BluetoothSdk from "@mentra/bluetooth-sdk"
import {deviceIntegrations} from "../devices/builtins"
import {FirmwareUpdateService} from "../ota/UpdateService"
import {FirmwareUpdateError, type FirmwareEntryPoint, type FirmwareTarget} from "../ota/types"

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
  supports(model: string, entryPoint: FirmwareEntryPoint): boolean {
    return deviceIntegrations.forModel(model)?.firmware?.entryPoints.includes(entryPoint) ?? false
  },
  open: firmwareUpdateService.open.bind(firmwareUpdateService),
  snapshot: firmwareUpdateService.snapshot.bind(firmwareUpdateService),
  subscribe: firmwareUpdateService.subscribe.bind(firmwareUpdateService),
  perform: firmwareUpdateService.perform.bind(firmwareUpdateService),
  assertSafeToRelease: firmwareUpdateService.assertSafeToRelease.bind(firmwareUpdateService),
  suspendNewWork: firmwareUpdateService.suspendNewWork.bind(firmwareUpdateService),
  diagnosticSnapshot: firmwareUpdateService.diagnosticSnapshot.bind(firmwareUpdateService),
}
