import {useEffect, useRef, useState} from "react"

import BluetoothSdk, {DeviceModels} from "../index"
import type {Device, DeviceModel} from "../BluetoothSdk.types"

export type BluetoothScanDedupe = "id" | "name" | ((device: Device) => string)

export type UseBluetoothScanOptions = {
  dedupe?: BluetoothScanDedupe
  model?: DeviceModel
  onError?: (error: unknown) => void
  timeoutMs?: number
}

export type BluetoothScanHookResult = {
  clearResults: () => void
  devices: Device[]
  error: unknown | null
  model: DeviceModel
  scanning: boolean
  selectedDevice: Device | null
  selectDevice: (device: Device | null) => void
  setModel: (model: DeviceModel) => void
  startScan: (model?: DeviceModel) => Promise<Device[]>
  stopScan: () => Promise<void>
}

function dedupeKey(device: Device, dedupe: BluetoothScanDedupe): string {
  if (typeof dedupe === "function") {
    return dedupe(device)
  }
  if (dedupe === "name") {
    return `${device.model}:${device.name}`
  }
  return device.id
}

function dedupeDevices(devices: Device[], dedupe: BluetoothScanDedupe): Device[] {
  const seen = new Set<string>()
  const nextDevices: Device[] = []

  devices.forEach((device) => {
    const key = dedupeKey(device, dedupe)
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    nextDevices.push(device)
  })

  return nextDevices
}

function hasDevice(devices: Device[], selectedDevice: Device | null, dedupe: BluetoothScanDedupe): boolean {
  if (!selectedDevice) {
    return true
  }
  const selectedKey = dedupeKey(selectedDevice, dedupe)
  return devices.some((device) => dedupeKey(device, dedupe) === selectedKey)
}

export function useBluetoothScan(options: UseBluetoothScanOptions = {}): BluetoothScanHookResult {
  const [devices, setDevices] = useState<Device[]>([])
  const [error, setError] = useState<unknown | null>(null)
  const [model, setModelState] = useState<DeviceModel>(options.model ?? DeviceModels.MentraLive)
  const [scanning, setScanning] = useState(false)
  const [selectedDevice, selectDevice] = useState<Device | null>(null)
  const activeScanRef = useRef(0)
  const dedupeRef = useRef<BluetoothScanDedupe>(options.dedupe ?? "id")
  const onErrorRef = useRef(options.onError)
  const scanningRef = useRef(false)
  const timeoutMsRef = useRef(options.timeoutMs)

  useEffect(() => {
    dedupeRef.current = options.dedupe ?? "id"
    onErrorRef.current = options.onError
    timeoutMsRef.current = options.timeoutMs
  }, [options.dedupe, options.onError, options.timeoutMs])

  useEffect(() => {
    scanningRef.current = scanning
  }, [scanning])

  useEffect(() => {
    if (!hasDevice(devices, selectedDevice, dedupeRef.current)) {
      selectDevice(null)
    }
  }, [devices, selectedDevice])

  useEffect(() => {
    return () => {
      if (!scanningRef.current) {
        return
      }
      activeScanRef.current += 1
      void BluetoothSdk.stopScan().catch(() => undefined)
    }
  }, [])

  function clearResults() {
    setDevices([])
    selectDevice(null)
  }

  function setModel(nextModel: DeviceModel) {
    setModelState(nextModel)
    clearResults()
  }

  async function startScan(nextModel?: DeviceModel): Promise<Device[]> {
    const scanId = activeScanRef.current + 1
    activeScanRef.current = scanId
    const scanModel = nextModel ?? model
    if (nextModel && nextModel !== model) {
      setModelState(nextModel)
    }

    setError(null)
    setScanning(true)
    scanningRef.current = true
    setDevices([])
    selectDevice(null)

    try {
      const nextDevices = await BluetoothSdk.scan(scanModel, {
        ...(timeoutMsRef.current == null ? {} : {timeoutMs: timeoutMsRef.current}),
        onResults: (results) => {
          if (activeScanRef.current !== scanId) {
            return
          }
          setDevices(dedupeDevices(results, dedupeRef.current))
        },
      })
      const finalDevices = dedupeDevices(nextDevices, dedupeRef.current)
      if (activeScanRef.current === scanId) {
        setDevices(finalDevices)
        setError(null)
      }
      return finalDevices
    } catch (nextError) {
      if (activeScanRef.current === scanId) {
        setError(nextError)
        onErrorRef.current?.(nextError)
      }
      throw nextError
    } finally {
      if (activeScanRef.current === scanId) {
        setScanning(false)
        scanningRef.current = false
      }
    }
  }

  async function stopScan() {
    activeScanRef.current += 1
    setScanning(false)
    scanningRef.current = false
    await BluetoothSdk.stopScan()
  }

  return {
    clearResults,
    devices,
    error,
    model,
    scanning,
    selectedDevice,
    selectDevice,
    setModel,
    startScan,
    stopScan,
  }
}
