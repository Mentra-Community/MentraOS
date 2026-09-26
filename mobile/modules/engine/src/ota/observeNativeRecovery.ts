import BluetoothSdk from "@mentra/bluetooth-sdk"
import type {NativeFirmwareUpdateSnapshot} from "@mentra/bluetooth-sdk/firmware-updates"
import {deviceIntegrations} from "../devices/builtins"
import {NativeFirmwareObservation} from "./NativeFirmwareObservation"

/** Local observation only. Safe outside authentication: no release lookup, reconnect, query or Start. */
export function observeNativeRecovery(listener: (snapshot: NativeFirmwareUpdateSnapshot | null) => void): () => void {
  let stopped = false
  let reading = false
  let refreshAgain = false
  let key: string | null = null
  let observation: NativeFirmwareObservation | null = null

  const refresh = async () => {
    if (stopped) return
    if (reading) {
      refreshAgain = true
      return
    }
    reading = true
    try {
      do {
        refreshAgain = false
        const device = await BluetoothSdk.getDefaultDevice()
        if (stopped) return
        const integration = device && deviceIntegrations.forModel(device.model)
        const nextKey = device && integration?.firmware ? JSON.stringify([integration.id, device.id]) : null
        if (nextKey !== key) {
          observation?.dispose()
          observation = null
          key = nextKey
          listener(null)
        }
        if (!device || !integration?.firmware) continue
        if (!observation) {
          observation = new NativeFirmwareObservation(
            {integrationId: integration.id, deviceId: device.id},
            {
              read: () => BluetoothSdk.getFirmwareUpdateSnapshot(device.id),
              listen: (receive) => {
                const sub = BluetoothSdk.addListener("firmware_update", receive)
                return () => sub.remove()
              },
            },
            listener,
            () => {}, // The next local connection/status event retries hydration.
          )
        }
        await observation.start()
      } while (refreshAgain && !stopped)
    } catch {
      // No SGC exists before the first connection. Reading its absence must not open a flow.
    } finally {
      reading = false
      if (refreshAgain && !stopped) void refresh()
    }
  }

  const bluetooth = BluetoothSdk.subscribeBluetoothStatus(() => void refresh())
  const glasses = BluetoothSdk.subscribeGlassesStatus((change) => {
    if ("connection" in change) void refresh()
  })
  const native = BluetoothSdk.addListener("firmware_update", () => {
    if (!observation?.snapshot()) void refresh()
  })
  void refresh()
  return () => {
    stopped = true
    bluetooth()
    glasses()
    native.remove()
    observation?.dispose()
  }
}
