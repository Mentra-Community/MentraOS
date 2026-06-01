import type {
  GlassesConnectionStatus,
  GlassesStatus,
  HotspotStatus,
  OtaProgress,
  OtaStatus,
  OtaUpdateInfo,
  WifiStatus,
} from "@mentra/bluetooth-sdk-internal"
import {create} from "zustand"
import {subscribeWithSelector} from "zustand/middleware"

export function isGlassesConnected(connection: GlassesConnectionStatus): boolean {
  return connection.state === "connected"
}

export function isGlassesReady(connection: GlassesConnectionStatus): boolean {
  return connection.state === "connected" && connection.fullyBooted
}

export function isGlassesLinkLayerBusy(connection: GlassesConnectionStatus): boolean {
  return connection.state === "scanning" || connection.state === "connecting" || connection.state === "bonding"
}

export const selectGlassesConnected = (state: {connection: GlassesConnectionStatus}) =>
  isGlassesConnected(state.connection)

export const selectGlassesReady = (state: {connection: GlassesConnectionStatus}) => isGlassesReady(state.connection)

interface GlassesState extends GlassesStatus {
  systemTimeMs: number
  wifiStatusKnown: boolean
  setGlassesInfo: (info: GlassesInfoUpdate) => void
  setBatteryInfo: (batteryLevel: number, charging: boolean, caseBatteryLevel: number, caseCharging: boolean) => void
  setWifiInfo: (connected: boolean, ssid: string) => void
  setHotspotInfo: (enabled: boolean, ssid: string, password: string, ip: string) => void
  // OTA methods
  otaStatus: OtaStatus | null
  setOtaStatus: (status: OtaStatus | null) => void
  setOtaUpdateAvailable: (info: OtaUpdateInfo | null) => void
  setOtaProgress: (progress: OtaProgress | null) => void
  setOtaInProgress: (inProgress: boolean) => void
  setMtkUpdatedThisSession: (updated: boolean) => void
  clearOtaState: () => void
  reset: () => void
  mtkUpdatedThisSession: boolean
}

type LegacyWifiFields = {
  wifiConnected?: boolean
  wifiSsid?: string
  wifiLocalIp?: string
}

type LegacyHotspotFields = {
  hotspotEnabled?: boolean
  hotspotSsid?: string
  hotspotPassword?: string
  hotspotGatewayIp?: string
  hotspotLocalIp?: string
}

type GlassesInfoUpdate = Partial<GlassesStatus> & LegacyWifiFields & LegacyHotspotFields

function wifiFromLegacyFields(info: LegacyWifiFields): WifiStatus | null {
  if (info.wifiConnected === true) {
    const ssid = info.wifiSsid?.trim()
    const localIp = info.wifiLocalIp?.trim()
    return ssid ? {state: "connected", ssid, ...(localIp ? {localIp} : {})} : null
  }
  if (info.wifiConnected === false) {
    return {state: "disconnected"}
  }
  return null
}

function hotspotFromLegacyFields(info: LegacyHotspotFields): HotspotStatus | null {
  if (info.hotspotEnabled === true) {
    const ssid = info.hotspotSsid?.trim()
    const password = info.hotspotPassword?.trim()
    const localIp = (info.hotspotGatewayIp ?? info.hotspotLocalIp)?.trim()
    return ssid && password && localIp ? {state: "enabled", ssid, password, localIp} : null
  }
  if (info.hotspotEnabled === false) {
    return {state: "disabled"}
  }
  return null
}

export const getGlasesInfoPartial = (state: GlassesStatus) => {
  const wifi = state.wifi
  const connected = isGlassesConnected(state.connection)
  return {
    batteryLevel: state.batteryLevel,
    charging: state.charging,
    caseBatteryLevel: state.caseBatteryLevel,
    caseCharging: state.caseCharging,
    connected,
    wifiConnected: wifi.state === "connected",
    wifiSsid: wifi.state === "connected" ? wifi.ssid : "",
    deviceModel: state.deviceModel,
    // Cloud GlassesInfo uses modelName, map from deviceModel so the cloud
    // knows which device is connected when it receives connection state updates
    modelName: state.deviceModel || null,
  }
}

interface GlassesStore extends GlassesStatus {
  systemTimeMs: number
  mtkUpdatedThisSession: boolean
  wifiStatusKnown: boolean
  otaStatus: OtaStatus | null
}

const initialState: GlassesStore = {
  // state:
  connection: {state: "disconnected"},
  micEnabled: false,
  bluetoothClassicConnected: false,
  signalStrength: -1,
  signalStrengthUpdatedAt: 0,
  voiceActivityDetectionEnabled: true,
  // device info
  deviceModel: "",
  androidVersion: "",
  firmwareVersion: "",
  bluetoothMacAddress: "",
  leftMacAddress: "",
  rightMacAddress: "",
  buildNumber: "",
  systemTimeMs: 0,
  otaVersionUrl: "",
  appVersion: "",
  bluetoothName: "",
  serialNumber: "",
  style: "",
  color: "",
  mtkFirmwareVersion: "",
  besFirmwareVersion: "",
  // wifi info
  wifi: {state: "disconnected"},
  wifiStatusKnown: false,
  // battery info
  batteryLevel: -1,
  charging: false,
  caseBatteryLevel: -1,
  caseCharging: false,
  caseOpen: false,
  caseRemoved: true,
  // hotspot info
  hotspot: {state: "disabled"},
  // OTA update info
  otaStatus: null,
  otaUpdateAvailable: null,
  otaProgress: null,
  otaInProgress: false,
  mtkUpdatedThisSession: false,
  // ring:
  controllerConnected: false,
  controllerFullyBooted: false,
  controllerMacAddress: "",
  controllerBatteryLevel: -1,
  controllerSignalStrength: -1,
}

export const useGlassesStore = create<GlassesState>()(
  subscribeWithSelector((set) => ({
    ...initialState,

    setGlassesInfo: (info) =>
      set((state) => {
        const {
          wifiConnected,
          wifiSsid,
          wifiLocalIp,
          hotspotEnabled,
          hotspotSsid,
          hotspotPassword,
          hotspotGatewayIp,
          hotspotLocalIp,
          wifi,
          hotspot,
          ...sdkInfo
        } = info
        const wifiUpdate = wifi ?? wifiFromLegacyFields({wifiConnected, wifiSsid, wifiLocalIp})
        const hotspotUpdate =
          hotspot ??
          hotspotFromLegacyFields({hotspotEnabled, hotspotSsid, hotspotPassword, hotspotGatewayIp, hotspotLocalIp})
        const hasWifiInfoUpdate =
          Object.prototype.hasOwnProperty.call(info, "wifi") ||
          Object.prototype.hasOwnProperty.call(info, "wifiConnected") ||
          Object.prototype.hasOwnProperty.call(info, "wifiSsid") ||
          Object.prototype.hasOwnProperty.call(info, "wifiLocalIp")
        const next = {
          ...state,
          ...sdkInfo,
          ...(wifiUpdate ? {wifi: wifiUpdate} : {}),
          ...(hotspotUpdate ? {hotspot: hotspotUpdate} : {}),
          ...(hasWifiInfoUpdate ? {wifiStatusKnown: true} : {}),
        }
        if (!isGlassesConnected(next.connection)) {
          next.wifiStatusKnown = false
        }
        return next
      }),

    setBatteryInfo: (batteryLevel, charging, caseBatteryLevel, caseCharging) =>
      set({
        batteryLevel,
        charging,
        caseBatteryLevel,
        caseCharging,
      }),

    setWifiInfo: (connected, ssid) =>
      set(() => {
        const trimmedSsid = ssid.trim()
        if (connected && !trimmedSsid) {
          return {}
        }
        const wifi: WifiStatus = connected ? {state: "connected", ssid: trimmedSsid} : {state: "disconnected"}
        return {
          wifi,
          wifiStatusKnown: true,
        }
      }),

    setHotspotInfo: (enabled: boolean, ssid: string, password: string, ip: string) =>
      set(() => {
        const hotspot = hotspotFromLegacyFields({
          hotspotEnabled: enabled,
          hotspotSsid: ssid,
          hotspotPassword: password,
          hotspotGatewayIp: ip,
        })
        return hotspot ? {hotspot} : {}
      }),

    // OTA methods
    setOtaStatus: (status: OtaStatus | null) => set({otaStatus: status}),

    setOtaUpdateAvailable: (info: OtaUpdateInfo | null) => set({otaUpdateAvailable: info}),

    setOtaProgress: (progress: OtaProgress | null) =>
      set((state) => {
        const otaInProgress = progress !== null && progress.status !== "FINISHED" && progress.status !== "FAILED"
        console.log("🔍 GLASSES STORE: setOtaProgress called with:", JSON.stringify(progress))
        console.log("🔍 GLASSES STORE: otaInProgress =", otaInProgress)

        // Never allow progress to regress within the same stage+currentUpdate — except a new
        // work wave (STARTED) or the step after FINISHED (multi-hop APK: 27→31→36 re-downloads from 0).
        const prev = state.otaProgress
        const sameWave =
          progress &&
          prev &&
          progress.stage === prev.stage &&
          progress.currentUpdate === prev.currentUpdate &&
          progress.progress < prev.progress
        if (sameWave) {
          const nextIsNewWave = progress.status === "STARTED" || prev.status === "FINISHED"
          if (!nextIsNewWave) {
            return {otaProgress: {...progress, progress: prev.progress}, otaInProgress}
          }
        }

        return {otaProgress: progress, otaInProgress}
      }),

    setOtaInProgress: (inProgress: boolean) => set({otaInProgress: inProgress}),

    setMtkUpdatedThisSession: (updated: boolean) => set({mtkUpdatedThisSession: updated}),

    clearOtaState: () =>
      set({
        otaUpdateAvailable: null,
        otaProgress: null,
        otaInProgress: false,
        // Note: mtkUpdatedThisSession is NOT cleared here - it stays true until glasses disconnect/reboot
      }),

    reset: () => set(initialState),
  })),
)

export function getGlassesSystemTimeMs(): number {
  return useGlassesStore.getState().systemTimeMs ?? 0
}

export const waitForGlassesState = <K extends keyof GlassesState>(
  key: K,
  predicate: (value: GlassesState[K]) => boolean,
  timeoutMs = 1000,
): Promise<boolean> => {
  return new Promise((resolve) => {
    const state = useGlassesStore.getState()
    if (predicate(state[key])) {
      resolve(true)
      return
    }

    const unsubscribe = useGlassesStore.subscribe(
      (s) => s[key],
      (value) => {
        if (predicate(value)) {
          unsubscribe()
          resolve(true)
        }
      },
    )

    setTimeout(() => {
      unsubscribe()
      resolve(predicate(useGlassesStore.getState()[key]))
    }, timeoutMs)
  })
}
