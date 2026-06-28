/**
 * incidents facade — `toolkit.incidents`: incident-report submission over the
 * Cloud V2 core client.
 *
 * OEM/host code owns UI and wording. Island owns the OS/runtime mechanics:
 * context collection, recent phone logs, Cloud V2 create/artifact calls, local
 * automatic dedupe, and notifying connected glasses.
 */
import NetInfo from "@react-native-community/netinfo"
import Constants from "expo-constants"
import * as Location from "expo-location"
import {Platform} from "react-native"
import BluetoothSdk from "../../../bluetooth-sdk/build/_internal"
import type {
  IncidentAttachmentInput,
  IncidentContext,
  IncidentLogEntry,
  IncidentReport,
  IncidentStatus,
  IncidentTrigger,
} from "@mentra/cloud-client"
import {useAppStatusStore} from "../stores/apps"
import {useConnectionStore} from "../stores/connection"
import {useCoreStore} from "../stores/core"
import {useGlassesStore} from "../stores/glasses"
import {useSettingsStore, SETTINGS} from "../stores/settings"
import {isGlassesConnected} from "../services/GlassesReadiness"
import {cloudClientService} from "../services/CloudClientService"
import {logBuffer} from "../utils/devLogging"

export type {
  IncidentAttachmentInput,
  IncidentContext,
  IncidentLogEntry,
  IncidentReport,
  IncidentStatus,
  IncidentTrigger,
} from "@mentra/cloud-client"

export interface IncidentFileInput {
  trigger: IncidentTrigger
  report: IncidentReport
  screenshots?: IncidentAttachmentInput[]
  context?: Partial<IncidentContext>
  dedupeKey?: string
  dedupeWindowMs?: number
}

export interface IncidentFeedbackInput {
  feedback: string | Record<string, unknown>
  phoneState?: Record<string, unknown>
}

const SENSITIVE_SETTINGS_KEYS = ["core_token", "auth_token", "auth_email"] as const
const SENSITIVE_GLASSES_KEYS = ["hotspotPassword"] as const
const DEFAULT_AUTOMATIC_INCIDENT_DEDUPE_MS = 90_000
const automaticIncidentDedupeRegistry = new Map<string, number>()

function automaticDedupeShouldSkip(key: string, nowMs: number, windowMs: number): boolean {
  const previous = automaticIncidentDedupeRegistry.get(key)
  if (previous !== undefined && nowMs - previous < windowMs) return true

  automaticIncidentDedupeRegistry.set(key, nowMs)
  for (const [entryKey, entryTime] of automaticIncidentDedupeRegistry) {
    if (nowMs - entryTime > windowMs * 3) {
      automaticIncidentDedupeRegistry.delete(entryKey)
    }
  }
  return false
}

function priorityFromReport(report: IncidentReport): string | undefined {
  return report.systemPriority ?? (report.userSeverity ? `user-${report.userSeverity}` : undefined)
}

async function collectIncidentContext(extra?: Partial<IncidentContext>): Promise<IncidentContext> {
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
    console.log("incidents: failed to get network info:", error)
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
          console.log("incidents: failed to reverse geocode:", error)
        }
      }
    }
  } catch (error) {
    console.log("incidents: failed to get location:", error)
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

export const incidents = {
  async file(input: IncidentFileInput): Promise<{incidentId?: string; status?: IncidentStatus; error?: string}> {
    if (input.dedupeKey) {
      const shouldSkip = automaticDedupeShouldSkip(
        input.dedupeKey,
        Date.now(),
        input.dedupeWindowMs ?? DEFAULT_AUTOMATIC_INCIDENT_DEDUPE_MS,
      )
      if (shouldSkip) return {error: "duplicate_within_window"}
    }

    let incidentId: string
    let status: IncidentStatus
    try {
      const res = await cloudClientService.core.incidents.create({
        trigger: input.trigger,
        report: input.report,
        context: await collectIncidentContext(input.context),
        dedupeKey: input.dedupeKey,
        dedupeWindowMs: input.dedupeWindowMs,
      })
      incidentId = res.incidentId
      status = res.status
    } catch (error) {
      return {error: error instanceof Error ? error.message : String(error)}
    }

    const logs = logBuffer.getRecentLogs()
    if (logs.length > 0) {
      try {
        await cloudClientService.core.incidents.addLogs(incidentId, "phone", logs)
      } catch (error) {
        console.warn("incidents.file: add phone logs failed:", error instanceof Error ? error.message : error)
      }
    }

    incidents.notifyGlasses(incidentId, cloudClientService.getCoreUrl())

    if (input.screenshots && input.screenshots.length > 0) {
      try {
        await cloudClientService.core.incidents.addScreenshots(incidentId, input.screenshots)
      } catch (error) {
        console.warn("incidents.file: add screenshots failed:", error instanceof Error ? error.message : error)
      }
    }

    try {
      const completed = await cloudClientService.core.incidents.complete(incidentId)
      status = completed.status
    } catch (error) {
      console.warn("incidents.file: complete incident failed:", error instanceof Error ? error.message : error)
    }

    return {incidentId, status}
  },

  async fileAutomatic(input: IncidentFileInput): Promise<
    | {status: "filed"; incidentId: string}
    | {status: "skipped"; reason: string}
    | {status: "failed"; error: string}
  > {
    const result = await incidents.file(input)
    if (result.error === "duplicate_within_window") {
      return {status: "skipped", reason: "duplicate_within_window"}
    }
    if (result.error || !result.incidentId) {
      return {status: "failed", error: result.error ?? "incident creation failed"}
    }
    return {status: "filed", incidentId: result.incidentId}
  },

  notifyGlasses(incidentId: string, apiBaseUrl?: string | null): void {
    if (!isGlassesConnected(useGlassesStore.getState().connection)) return
    BluetoothSdk.sendIncidentId(incidentId, apiBaseUrl ?? cloudClientService.getCoreUrl())
  },

  create: (...args: Parameters<typeof cloudClientService.core.incidents.create>) =>
    cloudClientService.core.incidents.create(...args),

  addLogs: (...args: Parameters<typeof cloudClientService.core.incidents.addLogs>) =>
    cloudClientService.core.incidents.addLogs(...args),

  addScreenshots: (...args: Parameters<typeof cloudClientService.core.incidents.addScreenshots>) =>
    cloudClientService.core.incidents.addScreenshots(...args),

  complete: (...args: Parameters<typeof cloudClientService.core.incidents.complete>) =>
    cloudClientService.core.incidents.complete(...args),

  sendFeedback(input: IncidentFeedbackInput) {
    return cloudClientService.core.feedback.send(input)
  },

  collectContext: collectIncidentContext,
  priorityFromReport,
}
