import {useEffect, useRef, useState} from "react"

import BluetoothSdk from "../_private/BluetoothSdkModule"
import {
  createDisconnectedGlassesStatus,
  isConnectedGlassesConnectionStatus,
  isReadyGlassesConnectionStatus,
} from "../BluetoothSdk.types"
import type {
  BatteryStatusEvent,
  HotspotStatus,
  HotspotStatusChangeEvent,
  PublicBluetoothStatus,
  PublicGlassesStatus,
  WifiStatus,
  WifiStatusChangeEvent,
} from "../BluetoothSdk.types"

export type UseBluetoothStatusOptions = {
  enabled?: boolean
  onError?: (error: unknown) => void
}

export type BluetoothStatusHookResult = {
  bluetoothStatus: Partial<PublicBluetoothStatus>
  connected: boolean
  error: unknown | null
  glassesStatus: Partial<PublicGlassesStatus>
  loading: boolean
  ready: boolean
  refresh: () => Promise<void>
}

function wifiStatusFromEvent(event: WifiStatusChangeEvent): WifiStatus {
  switch (event.state) {
    case "connected":
      return {state: "connected", ssid: event.ssid, localIp: event.localIp}
    case "disconnected":
      return {state: "disconnected"}
  }
}

function hotspotStatusFromEvent(event: HotspotStatusChangeEvent): HotspotStatus {
  if (event.state === "enabled") {
    return {
      state: "enabled",
      ssid: event.ssid,
      password: event.password,
      localIp: event.localIp,
    }
  }
  return {state: event.state}
}

function mergeGlassesStatus(
  current: Partial<PublicGlassesStatus>,
  changed: Partial<PublicGlassesStatus>,
): Partial<PublicGlassesStatus> {
  if (changed.connection?.state === "disconnected") {
    return {...createDisconnectedGlassesStatus(), ...changed}
  }
  return {...current, ...changed}
}

export function useBluetoothStatus(options: UseBluetoothStatusOptions = {}): BluetoothStatusHookResult {
  const enabled = options.enabled ?? true
  const onErrorRef = useRef(options.onError)
  const [bluetoothStatus, setBluetoothStatus] = useState<Partial<PublicBluetoothStatus>>({})
  const [error, setError] = useState<unknown | null>(null)
  const [glassesStatus, setGlassesStatus] = useState<Partial<PublicGlassesStatus>>(() =>
    createDisconnectedGlassesStatus(),
  )
  const [loading, setLoading] = useState(enabled)

  useEffect(() => {
    onErrorRef.current = options.onError
  }, [options.onError])

  async function refresh() {
    setLoading(true)
    try {
      const [nextGlassesStatus, nextBluetoothStatus] = await Promise.all([
        BluetoothSdk.getGlassesStatus(),
        BluetoothSdk.getBluetoothStatus(),
      ])
      setGlassesStatus(nextGlassesStatus)
      setBluetoothStatus(nextBluetoothStatus)
      setError(null)
    } catch (nextError) {
      setError(nextError)
      onErrorRef.current?.(nextError)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return undefined
    }

    let mounted = true

    const loadInitialStatus = async () => {
      setLoading(true)
      try {
        const [nextGlassesStatus, nextBluetoothStatus] = await Promise.all([
          BluetoothSdk.getGlassesStatus(),
          BluetoothSdk.getBluetoothStatus(),
        ])
        if (!mounted) {
          return
        }
        setGlassesStatus(nextGlassesStatus)
        setBluetoothStatus(nextBluetoothStatus)
        setError(null)
      } catch (nextError) {
        if (!mounted) {
          return
        }
        setError(nextError)
        onErrorRef.current?.(nextError)
      } finally {
        if (mounted) {
          setLoading(false)
        }
      }
    }

    void loadInitialStatus()

    const removeGlasses = BluetoothSdk.onGlassesStatus((changed) => {
      setGlassesStatus((current) => mergeGlassesStatus(current, changed))
    })
    const removeBluetooth = BluetoothSdk.onBluetoothStatus((changed) => {
      setBluetoothStatus((current) => ({...current, ...changed}))
    })
    const batterySubscription = BluetoothSdk.addListener("battery_status", (event: BatteryStatusEvent) => {
      setGlassesStatus((current) => ({
        ...current,
        batteryLevel: event.level,
        charging: event.charging,
      }))
    })
    const wifiSubscription = BluetoothSdk.addListener("wifi_status_change", (event) => {
      setGlassesStatus((current) => ({...current, wifi: wifiStatusFromEvent(event)}))
    })
    const hotspotSubscription = BluetoothSdk.addListener("hotspot_status_change", (event) => {
      setGlassesStatus((current) => ({...current, hotspot: hotspotStatusFromEvent(event)}))
    })
    const hotspotErrorSubscription = BluetoothSdk.addListener("hotspot_error", () => {
      setGlassesStatus((current) => ({...current, hotspot: {state: "disabled"}}))
    })

    return () => {
      mounted = false
      removeGlasses()
      removeBluetooth()
      batterySubscription.remove()
      wifiSubscription.remove()
      hotspotSubscription.remove()
      hotspotErrorSubscription.remove()
    }
  }, [enabled])

  const connection = glassesStatus.connection
  const connected = connection ? isConnectedGlassesConnectionStatus(connection) : false
  const ready = connection ? isReadyGlassesConnectionStatus(connection) : false

  return {
    bluetoothStatus,
    connected,
    error,
    glassesStatus,
    loading,
    ready,
    refresh,
  }
}
