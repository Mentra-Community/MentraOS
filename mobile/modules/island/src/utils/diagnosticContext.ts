import NetInfo from "@react-native-community/netinfo"
import Constants from "expo-constants"
import * as Location from "expo-location"
import {Platform} from "react-native"
import type {ReportContext} from "@mentra/cloud-client"

import {useAppStatusStore} from "../stores/apps"
import {useConnectionStore} from "../stores/connection"
import {useCoreStore} from "../stores/core"
import {useGlassesStore} from "../stores/glasses"
import {SETTINGS, useSettingsStore} from "../stores/settings"

const SENSITIVE_SETTINGS_KEYS = ["core_token", "auth_token", "auth_email"] as const
const SENSITIVE_GLASSES_KEYS = ["hotspotPassword"] as const

export async function collectDiagnosticContext(extra?: Partial<ReportContext>): Promise<ReportContext> {
  const appletState = useAppStatusStore.getState()
  const settingsState = useSettingsStore.getState()
  const {setCoreInfo: _setCoreInfo, reset: _resetBluetooth, ...coreState} = useCoreStore.getState()
  const {
    setStatus: _setConnectionStatus,
    setUrl: _setConnectionUrl,
    setError: _setConnectionError,
    incrementReconnectAttempts: _incrementReconnectAttempts,
    resetReconnectAttempts: _resetReconnectAttempts,
    reset: _resetConnection,
    ...connectionState
  } = useConnectionStore.getState()
  const {
    setGlassesInfo: _setGlassesInfo,
    setBatteryInfo: _setBatteryInfo,
    setWifiInfo: _setWifiInfo,
    setHotspotInfo: _setHotspotInfo,
    setOtaUpdateAvailable: _setOtaUpdateAvailable,
    setOtaProgress: _setOtaProgress,
    setOtaInProgress: _setOtaInProgress,
    setMtkUpdatedThisSession: _setMtkUpdatedThisSession,
    clearOtaState: _clearOtaState,
    reset: _resetGlasses,
    ...glassesState
  } = useGlassesStore.getState()

  const filteredGlasses = Object.fromEntries(
    Object.entries(glassesState).filter(
      ([key]) => !SENSITIVE_GLASSES_KEYS.includes(key as (typeof SENSITIVE_GLASSES_KEYS)[number]),
    ),
  )
  const filteredSettings = Object.fromEntries(
    Object.entries(settingsState.settings || {}).filter(
      ([key]) => !SENSITIVE_SETTINGS_KEYS.includes(key as (typeof SENSITIVE_SETTINGS_KEYS)[number]),
    ),
  )

  let networkInfo: Record<string, unknown> = {type: "unknown", isConnected: false, isInternetReachable: false}
  try {
    const netState = await NetInfo.fetch()
    networkInfo = {
      type: netState.type,
      isConnected: netState.isConnected ?? false,
      isInternetReachable: netState.isInternetReachable ?? false,
    }
  } catch (error) {
    console.log("diagnosticContext: failed to get network info:", error)
  }

  let locationInfo: Record<string, unknown> | undefined
  try {
    const {status} = await Location.getForegroundPermissionsAsync()
    if (status === "granted") {
      const location = await Location.getLastKnownPositionAsync()
      if (location) {
        locationInfo = {
          latitude: Number(location.coords.latitude.toFixed(4)),
          longitude: Number(location.coords.longitude.toFixed(4)),
        }
        try {
          const [place] = await Location.reverseGeocodeAsync({
            latitude: location.coords.latitude,
            longitude: location.coords.longitude,
          })
          if (place) {
            locationInfo.place = [place.city, place.region, place.country].filter(Boolean).join(", ")
          }
        } catch (error) {
          console.log("diagnosticContext: failed to reverse geocode:", error)
        }
      }
    }
  } catch (error) {
    console.log("diagnosticContext: failed to get location:", error)
  }

  const offlineMode = await useSettingsStore.getState().getSetting(SETTINGS.offline_mode.key)
  const defaultWearable = await useSettingsStore.getState().getSetting(SETTINGS.default_wearable.key)
  const apps = appletState.apps.map((app) => ({
    packageName: app.packageName,
    name: app.name,
    running: app.running,
    loading: app.loading,
    healthy: app.healthy,
    hidden: app.hidden,
    type: app.type,
    offline: app.offline,
    local: app.local,
  }))

  return {
    app: {
      appVersion: process.env.EXPO_PUBLIC_MENTRAOS_VERSION || "version",
      buildCommit: process.env.EXPO_PUBLIC_BUILD_COMMIT || "commit",
      buildBranch: process.env.EXPO_PUBLIC_BUILD_BRANCH || "branch",
      buildTime: process.env.EXPO_PUBLIC_BUILD_TIME || "time",
      buildUser: process.env.EXPO_PUBLIC_BUILD_USER || "user",
      backendUrlOverride: process.env.EXPO_PUBLIC_BACKEND_URL_OVERRIDE || undefined,
    },
    phone: {
      deviceName: Constants.deviceName || "deviceName",
      osVersion: `${Platform.OS} ${Platform.Version}`,
      platform: Platform.OS,
      network: networkInfo,
      location: locationInfo,
    },
    glasses: filteredGlasses,
    runtime: {
      core: coreState,
      connection: connectionState,
    },
    apps: {
      apps,
      installed: apps.map((app) => app.packageName),
      running: apps.filter((app) => app.running).map((app) => app.packageName),
    },
    settings: {
      ...filteredSettings,
      offlineMode: !!offlineMode,
      defaultWearable,
    },
    ...extra,
  }
}
