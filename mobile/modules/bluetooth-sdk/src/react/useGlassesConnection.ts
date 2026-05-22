import {useEffect, useRef, useState} from "react"

import BluetoothSdk from "../index"
import type {ConnectOptions, Device, DeviceModel} from "../BluetoothSdk.types"

import {useBluetoothScan, type BluetoothScanHookResult} from "./useBluetoothScan"
import {useBluetoothStatus, type BluetoothStatusHookResult} from "./useBluetoothStatus"

export type DefaultDeviceStorage = {
  load: () => Promise<Device | null>
  save: (device: Device | null) => Promise<void>
}

export type GlassesConnectionAction =
  | "idle"
  | "scanning"
  | "connecting"
  | "disconnecting"
  | "forgetting"

export type UseGlassesConnectionOptions = {
  autoConnectDefault?: boolean
  defaultDeviceStorage?: DefaultDeviceStorage
  onError?: (error: unknown) => void
  scanModel?: DeviceModel
  scanTimeoutMs?: number
}

export type GlassesConnectionHookResult = BluetoothStatusHookResult & {
  action: GlassesConnectionAction
  busy: boolean
  clearDefaultDevice: () => Promise<void>
  connect: (device?: Device, options?: ConnectOptions) => Promise<void>
  connectDefault: (options?: ConnectOptions) => Promise<void>
  defaultDevice: Device | null
  disconnect: () => Promise<void>
  forget: () => Promise<void>
  scan: BluetoothScanHookResult
  setDefaultDevice: (device: Device | null) => Promise<void>
}

export function useGlassesConnection(
  options: UseGlassesConnectionOptions = {},
): GlassesConnectionHookResult {
  const status = useBluetoothStatus({onError: options.onError})
  const scan = useBluetoothScan({
    model: options.scanModel,
    onError: options.onError,
    timeoutMs: options.scanTimeoutMs,
  })
  const [action, setAction] = useState<GlassesConnectionAction>("idle")
  const [defaultDevice, setDefaultDeviceState] = useState<Device | null>(null)
  const [operationError, setOperationError] = useState<unknown | null>(null)
  const autoConnectAttemptedRef = useRef(false)
  const defaultDeviceStorageRef = useRef(options.defaultDeviceStorage)
  const onErrorRef = useRef(options.onError)

  useEffect(() => {
    defaultDeviceStorageRef.current = options.defaultDeviceStorage
    onErrorRef.current = options.onError
  }, [options.defaultDeviceStorage, options.onError])

  useEffect(() => {
    let mounted = true

    const loadDefaultDevice = async () => {
      try {
        const [nativeDefaultDevice, storedDefaultDevice] = await Promise.all([
          BluetoothSdk.getDefaultDevice(),
          defaultDeviceStorageRef.current?.load() ?? Promise.resolve(null),
        ])
        if (!mounted) {
          return
        }
        const nextDefaultDevice = storedDefaultDevice ?? nativeDefaultDevice
        if (nextDefaultDevice) {
          await BluetoothSdk.setDefaultDevice(nextDefaultDevice)
        }
        if (mounted) {
          setDefaultDeviceState(nextDefaultDevice)
          setOperationError(null)
        }
      } catch (nextError) {
        if (!mounted) {
          return
        }
        setOperationError(nextError)
        onErrorRef.current?.(nextError)
      }
    }

    void loadDefaultDevice()

    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    const subscription = BluetoothSdk.addListener("default_device_changed", (event) => {
      const nextDefaultDevice = event.device ?? null
      setDefaultDeviceState(nextDefaultDevice)
      void defaultDeviceStorageRef.current?.save(nextDefaultDevice).catch((nextError) => {
        setOperationError(nextError)
        onErrorRef.current?.(nextError)
      })
    })

    return () => {
      subscription.remove()
    }
  }, [])

  useEffect(() => {
    if (!options.autoConnectDefault || autoConnectAttemptedRef.current || status.connected || !defaultDevice) {
      return
    }

    autoConnectAttemptedRef.current = true
    void connectDefault().catch(() => undefined)
  }, [defaultDevice, options.autoConnectDefault, status.connected])

  async function runConnectionAction<T>(
    nextAction: Exclude<GlassesConnectionAction, "idle" | "scanning">,
    operation: () => Promise<T>,
  ): Promise<T> {
    setAction(nextAction)
    setOperationError(null)
    try {
      const result = await operation()
      setOperationError(null)
      return result
    } catch (nextError) {
      setOperationError(nextError)
      onErrorRef.current?.(nextError)
      throw nextError
    } finally {
      setAction("idle")
    }
  }

  async function setDefaultDevice(device: Device | null) {
    await runConnectionAction("connecting", async () => {
      await BluetoothSdk.setDefaultDevice(device)
      await defaultDeviceStorageRef.current?.save(device)
      setDefaultDeviceState(device)
    })
  }

  async function clearDefaultDevice() {
    await runConnectionAction("forgetting", async () => {
      await BluetoothSdk.clearDefaultDevice()
      await defaultDeviceStorageRef.current?.save(null)
      setDefaultDeviceState(null)
      scan.selectDevice(null)
    })
  }

  async function connect(device?: Device, connectOptions?: ConnectOptions) {
    await runConnectionAction("connecting", async () => {
      const targetDevice = device ?? scan.selectedDevice
      if (targetDevice) {
        await BluetoothSdk.connect(targetDevice, connectOptions)
        if (connectOptions?.saveAsDefault !== false) {
          await defaultDeviceStorageRef.current?.save(targetDevice)
          setDefaultDeviceState(targetDevice)
        }
        return
      }
      await BluetoothSdk.connectDefault(connectOptions)
    })
  }

  async function connectDefault(connectOptions?: ConnectOptions) {
    await runConnectionAction("connecting", async () => {
      await BluetoothSdk.connectDefault(connectOptions)
    })
  }

  async function disconnect() {
    await runConnectionAction("disconnecting", async () => {
      await BluetoothSdk.disconnect()
    })
  }

  async function forget() {
    await runConnectionAction("forgetting", async () => {
      await BluetoothSdk.forget()
      scan.clearResults()
    })
  }

  const busy = action !== "idle" || scan.scanning || status.loading

  return {
    ...status,
    action: scan.scanning ? "scanning" : action,
    busy,
    clearDefaultDevice,
    connect,
    connectDefault,
    defaultDevice,
    disconnect,
    error: operationError ?? scan.error ?? status.error,
    forget,
    scan,
    setDefaultDevice,
  }
}
