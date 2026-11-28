import NetInfo from "@react-native-community/netinfo"
import Constants from "expo-constants"
import * as Location from "expo-location"
import {Platform} from "react-native"
import type {ReportContext} from "@mentra/cloud-client"

import appRegistry from "../services/AppRegistry"
import {cloudClientService} from "../services/CloudClientService"
import localMiniappRuntime from "../services/LocalMiniappRuntime"
import {getLastOpenTime, useAppStatusStore} from "../stores/apps"
import {useCoreStore} from "../stores/core"
import {useGlassesStore} from "../stores/glasses"
import {SETTINGS, useSettingsStore} from "../stores/settings"
import {getAppBuildInfo} from "./appBuildInfo"
import {buildMiniappDiagnosticContext} from "./miniappDiagnostics"
import {redactOtaDiagnosticError} from "./otaDiagnosticRedaction"

/**
 * Account credentials. The native Bluetooth status snapshot mirrors these same
 * keys from its settings store, so the policy applies to `runtime.core` too.
 */
const SENSITIVE_SETTINGS_KEYS = ["core_token", "auth_token", "auth_email"] as const
const SENSITIVE_GLASSES_KEYS = ["hotspotPassword"] as const

function omitSensitiveSettings(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).filter(
      ([key]) => !SENSITIVE_SETTINGS_KEYS.includes(key as (typeof SENSITIVE_SETTINGS_KEYS)[number]),
    ),
  )
}

/**
 * The glasses store keeps hotspot credentials NESTED (`hotspot: {state, ssid,
 * password, localIp}`), not just on the legacy top-level `hotspotPassword` key —
 * strip the password before the state is attached to a report.
 */
function redactNestedCredentials(glasses: Record<string, unknown>): Record<string, unknown> {
  glasses = {...glasses}
  for (const [key, errorKey] of [
    ["otaStatus", "error"],
    ["otaProgress", "errorMessage"],
  ]) {
    const status = glasses[key]
    if (status && typeof status === "object" && errorKey in status) {
      const values = status as Record<string, unknown>
      glasses[key] = {...values, [errorKey]: redactOtaDiagnosticError(values[errorKey])}
    }
  }
  const hotspot = glasses.hotspot
  if (hotspot && typeof hotspot === "object" && "password" in hotspot) {
    const {password: _password, ...rest} = hotspot as Record<string, unknown>
    return {...glasses, hotspot: {...rest, password: "[REDACTED]"}}
  }
  return glasses
}

/**
 * Calendar events are shaped objects carrying event titles and locations, so
 * PII is in the value. Keep the count and drop the contents.
 */
function redactCalendarEvents(settings: Record<string, unknown>): Record<string, unknown> {
  const key = SETTINGS.calendar_events.key
  if (!(key in settings)) return settings
  const events = settings[key]
  return {
    ...settings,
    [key]: Array.isArray(events) ? `<${events.length} event(s)>` : "[REDACTED]",
  }
}

export async function collectDiagnosticContext(extra?: Partial<ReportContext>): Promise<ReportContext> {
  const appletState = useAppStatusStore.getState()
  const settingsState = useSettingsStore.getState()
  const {setCoreInfo: _setCoreInfo, reset: _resetBluetooth, ...coreState} = useCoreStore.getState()
  const {status, audioTransport} = cloudClientService.getStatus()
  const audioPosition = cloudClientService.getAudioPosition()
  // Project only current Cloud V2 metadata. The old connection store lost its
  // writer with Cloud V1; neither subscription intent nor this submitted-audio
  // cursor proves that the cloud received or transcribed a frame.
  const connectionState = {
    status,
    audioTransport,
    handshakeComplete: cloudClientService.isConnected(),
    hasDesiredAudioSubscriptions: cloudClientService.hasAudioSubscriptions(),
    audioPosition: audioPosition ? {sessionTag: audioPosition.sessionTag, offsetMs: audioPosition.offsetMs} : null,
  }
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

  const filteredGlasses = redactNestedCredentials(
    Object.fromEntries(
      Object.entries(glassesState).filter(
        ([key]) => !SENSITIVE_GLASSES_KEYS.includes(key as (typeof SENSITIVE_GLASSES_KEYS)[number]),
      ),
    ),
  )
  const filteredSettings = redactCalendarEvents(omitSensitiveSettings(settingsState.settings || {}))
  const filteredCore = redactCalendarEvents(omitSensitiveSettings(coreState))

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
  const miniappRuntime = localMiniappRuntime.getDiagnosticSnapshot()
  const miniapps = buildMiniappDiagnosticContext({
    apps: appletState.apps,
    foregroundedPackage: appletState.foregroundedPackage,
    runtime: miniappRuntime,
    getLastOpenedAtMs: (app) => getLastOpenTime(app.packageName),
    getManifest: (app) =>
      app.local && app.version ? appRegistry.getMiniappManifest(app.packageName, app.version) : undefined,
    getReleaseIdentity: (app) =>
      app.local && app.version ? appRegistry.getReleaseIdentity(app.packageName, app.version) : undefined,
  })

  return {
    app: getAppBuildInfo(),
    phone: {
      deviceName: Constants.deviceName || "deviceName",
      osVersion: `${Platform.OS} ${Platform.Version}`,
      platform: Platform.OS,
      network: networkInfo,
      location: locationInfo,
    },
    glasses: filteredGlasses,
    runtime: {
      core: filteredCore,
      connection: connectionState,
      miniapps: miniappRuntime,
    },
    apps: miniapps,
    settings: {
      ...filteredSettings,
      offlineMode: !!offlineMode,
      defaultWearable,
    },
    ...extra,
  }
}
