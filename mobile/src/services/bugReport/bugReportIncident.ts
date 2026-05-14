import CoreModule from "@mentra/bluetooth-sdk"
import NetInfo from "@react-native-community/netinfo"
import Constants from "expo-constants"
import * as ImagePicker from "expo-image-picker"
import * as Location from "expo-location"
import {Platform} from "react-native"

import restComms from "@/services/RestComms"
import {useAppStatusStore} from "@mentra/island"
import {useConnectionStore} from "@/stores/connection"
import {useCoreStore} from "@/stores/core"
import {useDebugStore} from "@/stores/debug"
import {useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSettingsStore} from "@/stores/settings"
import {logBuffer} from "@/utils/dev/logging"

const SENSITIVE_SETTINGS_KEYS = ["core_token", "auth_token", "auth_email"] as const
const SENSITIVE_GLASSES_KEYS = ["hotspotPassword"] as const

export interface BuildBugReportFeedbackDataForBugParams {
  expectedBehavior: string
  actualBehavior: string
  severityRating: number
  contactEmail?: string
  /** Merged into root of feedback payload (e.g. automatic, source). */
  extraFeedbackFields?: Record<string, unknown>
}

export function buildBugReportPhoneState(): Record<string, unknown> {
  const appletState = useAppStatusStore.getState()
  const settingsState = useSettingsStore.getState()
  const {setCoreInfo: _setCoreInfo, reset: _resetBluetooth, ...bluetoothState} = useCoreStore.getState()
  const {setDebugInfo: _setDebugInfo, reset: _resetDebug, ...debugState} = useDebugStore.getState()
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

  const applets = appletState.apps.map((app) => ({
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
    glasses: filteredGlasses,
    core: bluetoothState,
    debug: debugState,
    connection: connectionState,
    applets: {
      apps: applets,
      installed: applets.map((app) => app.packageName),
    },
    installedApplets: applets.map((app) => app.packageName),
    settings: filteredSettings,
  }
}

/**
 * Builds the bug-report feedback object matching the manual Feedback screen bug branch.
 */
export async function buildBugReportFeedbackDataForBug(
  params: BuildBugReportFeedbackDataForBugParams,
): Promise<Record<string, unknown>> {
  const {expectedBehavior, actualBehavior, severityRating, contactEmail, extraFeedbackFields} = params

  const customBackendUrl = process.env.EXPO_PUBLIC_BACKEND_URL_OVERRIDE
  const isBetaBuild = !!customBackendUrl
  const osVersion = `${Platform.OS} ${Platform.Version}`
  const deviceName = Constants.deviceName || "deviceName"
  const mobileAppVersion = process.env.EXPO_PUBLIC_MENTRAOS_VERSION || "version"
  const buildCommit = process.env.EXPO_PUBLIC_BUILD_COMMIT || "commit"
  const buildBranch = process.env.EXPO_PUBLIC_BUILD_BRANCH || "branch"
  const buildTime = process.env.EXPO_PUBLIC_BUILD_TIME || "time"
  const buildUser = process.env.EXPO_PUBLIC_BUILD_USER || "user"

  const offlineMode = await useSettingsStore.getState().getSetting(SETTINGS.offline_mode.key)
  const defaultWearable = await useSettingsStore.getState().getSetting(SETTINGS.default_wearable.key)

  let networkInfo = {type: "unknown", isConnected: false, isInternetReachable: false}
  try {
    const netState = await NetInfo.fetch()
    networkInfo = {
      type: netState.type,
      isConnected: netState.isConnected ?? false,
      isInternetReachable: netState.isInternetReachable ?? false,
    }
  } catch (e) {
    console.log("Failed to get network info:", e)
  }

  let locationInfo: string | undefined
  let locationPlace: string | undefined
  try {
    const {status} = await Location.getForegroundPermissionsAsync()
    if (status === "granted") {
      const location = await Location.getLastKnownPositionAsync()
      if (location) {
        locationInfo = `${location.coords.latitude.toFixed(4)}, ${location.coords.longitude.toFixed(4)}`
        try {
          const [place] = await Location.reverseGeocodeAsync({
            latitude: location.coords.latitude,
            longitude: location.coords.longitude,
          })
          if (place) {
            const parts = [place.city, place.region, place.country].filter(Boolean)
            if (parts.length > 0) {
              locationPlace = parts.join(", ")
            }
          }
        } catch (e) {
          console.log("Failed to reverse geocode:", e)
        }
      }
    }
  } catch (e) {
    console.log("Failed to get location:", e)
  }

  const apps = useAppStatusStore.getState().apps
  const runningApps = apps.filter((app) => app.running).map((app) => app.packageName)

  const glassesConnected = useGlassesStore.getState().connected
  const deviceModel = useGlassesStore.getState().deviceModel
  const glassesBluetoothName = useGlassesStore.getState().bluetoothName
  const buildNumber = useGlassesStore.getState().buildNumber
  const glassesFwVersion = useGlassesStore.getState().fwVersion
  const appVersion = useGlassesStore.getState().appVersion
  const serialNumber = useGlassesStore.getState().serialNumber
  const androidVersion = useGlassesStore.getState().androidVersion
  const glassesWifi = useGlassesStore.getState().wifi
  const glassesWifiInfo =
    glassesWifi.state === "connected"
      ? {wifiConnected: true, wifiSsid: glassesWifi.ssid}
      : {wifiConnected: false}
  const glassesBatteryLevel = useGlassesStore.getState().batteryLevel

  const glassesBluetoothId = glassesBluetoothName?.split("_").pop() || glassesBluetoothName

  const feedbackData: Record<string, unknown> = {
    type: "bug",
    expectedBehavior,
    actualBehavior,
    severityRating,
    ...(contactEmail && {contactEmail}),
    systemInfo: {
      appVersion: mobileAppVersion,
      deviceName,
      osVersion,
      platform: Platform.OS,
      glassesConnected,
      defaultWearable: defaultWearable as string,
      runningApps,
      offlineMode: !!offlineMode,
      networkType: networkInfo.type,
      networkConnected: networkInfo.isConnected,
      internetReachable: networkInfo.isInternetReachable,
      ...(locationInfo && {location: locationInfo}),
      ...(locationPlace && {locationPlace}),
      ...(isBetaBuild && {isBetaBuild: true}),
      ...(isBetaBuild && customBackendUrl && {backendUrl: customBackendUrl}),
      buildCommit,
      buildBranch,
      buildTime,
      buildUser,
    },
    ...(glassesConnected && {
      glassesInfo: {
        deviceModel: deviceModel || undefined,
        bluetoothId: glassesBluetoothId || undefined,
        serialNumber: serialNumber || undefined,
        buildNumber: buildNumber || undefined,
        fwVersion: glassesFwVersion || undefined,
        appVersion: appVersion || undefined,
        androidVersion: androidVersion || undefined,
        ...glassesWifiInfo,
        ...(glassesBatteryLevel >= 0 && {batteryLevel: glassesBatteryLevel}),
      },
    }),
    ...extraFeedbackFields,
  }

  return feedbackData
}

export interface SubmitBugIncidentOptions {
  screenshots?: ImagePicker.ImagePickerAsset[]
}

/**
 * createIncident + phone logs + sendIncidentId (+ optional screenshots).
 * Mirrors the bug branch of Feedback after feedbackData is built.
 */
export async function submitBugIncident(
  feedbackData: Record<string, unknown>,
  options?: SubmitBugIncidentOptions,
): Promise<{ok: true; incidentId: string} | {ok: false; error: Error}> {
  const phoneState = buildBugReportPhoneState()
  const phoneBackendUrl = useSettingsStore.getState().getRestUrl()
  const res = await restComms.createIncident(feedbackData, phoneState)
  if (res.is_error()) {
    return {ok: false, error: res.error}
  }

  const {incidentId} = res.value

  const phoneLogs = logBuffer.getRecentLogs()
  if (phoneLogs.length > 0) {
    const logsRes = await restComms.uploadIncidentLogs(incidentId, phoneLogs)
    if (logsRes.is_error()) {
      console.error("Error uploading phone logs:", logsRes.error)
    }
  }

  const glassesConnected = useGlassesStore.getState().connected
  if (glassesConnected) {
    CoreModule.sendIncidentId(incidentId, phoneBackendUrl)
  }

  if (options?.screenshots && options.screenshots.length > 0) {
    const uploadRes = await restComms.uploadIncidentAttachments(incidentId, options.screenshots)
    if (uploadRes.is_error()) {
      console.error("Error uploading screenshots:", uploadRes.error)
    }
  }

  return {ok: true, incidentId}
}
