// The glasses' Bluetooth connection, as the SDK's native side reports it.
// eslint-disable-next-line no-restricted-imports
import PrivateBluetoothSdkModule from "../_private/BluetoothSdkModule"
import type {GlassesConnectionStatus} from "../BluetoothSdk.types"

/**
 * The glasses connection that the glasses Wi-Fi service and `link` read: one subscription to the
 * glasses status, from first use for the app's lifetime, and the status read once at that start.
 */

let connection: GlassesConnectionStatus = {state: "disconnected"}
let started: Promise<void> | null = null
const listeners = new Set<(connection: GlassesConnectionStatus) => void>()

/** Starts watching on first call; resolves once the current status has been read. */
export function watchGlassesConnection(): Promise<void> {
  if (started) return started
  let heard = false
  PrivateBluetoothSdkModule.onGlassesStatus((changed) => {
    if (!changed.connection) return
    heard = true
    connection = changed.connection
    for (const listener of listeners) listener(connection)
  })
  started = PrivateBluetoothSdkModule.getGlassesStatus().then(
    (status) => {
      // A change heard while the read was on its way is newer than the read.
      if (heard || !status?.connection) return
      connection = status.connection
      for (const listener of listeners) listener(connection)
    },
    () => undefined,
  )
  return started
}

export function glassesConnection(): GlassesConnectionStatus {
  return connection
}

export function onGlassesConnection(listener: (connection: GlassesConnectionStatus) => void): () => void {
  void watchGlassesConnection()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
