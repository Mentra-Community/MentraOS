import BluetoothSdk, {type Device} from "@mentra/bluetooth-sdk"
import {DeviceTypes} from "@mentra/engine"
import {useFocusEffect} from "expo-router"
import {useCallback, useRef, useState} from "react"
import {AppState} from "react-native"

// Allow the connected-device snapshot to settle before choosing a single NIMO.
const SETTLE_MS = 1000
const SCAN_MS = 60_000

/** iOS Companion discovery, including devices connected in system Settings. */
export function useNimoCompanionDiscovery(onSelect: (device: Device) => void) {
  const [devices, setDevices] = useState<Device[]>([])
  const [needsRetry, setNeedsRetry] = useState(false)
  const selectRef = useRef<(device: Device) => void>(() => {})
  const retryRef = useRef<() => void>(() => {})
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  // A focus cleanup must finish stopping its scan before a subsequent focus starts one.
  const stopTask = useRef(Promise.resolve())

  useFocusEffect(
    useCallback(() => {
      let active = true
      let foreground = AppState.currentState !== "background" && AppState.currentState !== "inactive"
      let generation = 0
      let scanning = false
      let selecting = false
      let results: Device[] = []
      let timer: ReturnType<typeof setTimeout> | undefined

      const stop = () => {
        generation += 1
        clearTimeout(timer)
        if (scanning) {
          scanning = false
          stopTask.current = BluetoothSdk.stopScan().catch((error) => {
            console.warn("NIMO discovery could not stop:", error)
          })
        }
        return stopTask.current
      }

      const select = async (device: Device) => {
        if (!active || !foreground || selecting || !results.some((item) => item.id === device.id)) return
        selecting = true
        const stopping = stop()
        const selectionGeneration = generation
        await stopping
        if (active && foreground && selectionGeneration === generation) onSelectRef.current(device)
      }
      selectRef.current = (device) => void select(device)

      const start = async () => {
        const stopping = stop()
        const current = generation
        results = []
        setDevices([])
        setNeedsRetry(false)
        await stopping
        if (!active || !foreground || selecting || current !== generation) return
        scanning = true
        try {
          await BluetoothSdk.scan(DeviceTypes.NIMO, {
            timeoutMs: SCAN_MS,
            onResults: (found) => {
              if (!active || !foreground || current !== generation) return
              // The _BLE device is only the notification side link, not Companion.
              results = found.filter((device) => device.model === DeviceTypes.NIMO && !/_ble$/i.test(device.name))
              setDevices(results)
              clearTimeout(timer)
              if (results.length === 1) {
                timer = setTimeout(() => void select(results[0]), SETTLE_MS)
              }
            },
          })
          if (active && current === generation) {
            scanning = false
            setNeedsRetry(results.length === 0)
          }
        } catch (error) {
          if (active && current === generation) {
            scanning = false
            clearTimeout(timer)
            results = []
            setDevices([])
            setNeedsRetry(true)
            console.warn("NIMO Companion discovery failed:", error)
          }
        }
      }

      retryRef.current = () => void start()
      if (foreground) void start()
      const subscription = AppState.addEventListener("change", (state) => {
        const nextForeground = state === "active"
        if (nextForeground === foreground) return
        foreground = nextForeground
        if (foreground) void start()
        else {
          selecting = false
          void stop()
        }
      })
      return () => {
        active = false
        retryRef.current = () => {}
        subscription.remove()
        void stop()
      }
    }, []),
  )

  return {
    devices,
    needsRetry,
    retry: () => retryRef.current(),
    select: (device: Device) => selectRef.current(device),
  }
}
