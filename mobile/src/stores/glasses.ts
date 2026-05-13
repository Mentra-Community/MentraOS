import {GlassesStatus, OtaProgress, OtaStatus, OtaUpdateInfo, WifiStatus} from "@mentra/bluetooth-sdk"
import {create} from "zustand"
import {subscribeWithSelector} from "zustand/middleware"

/** Native Bluetooth SDK ConnTypes (uppercase); RN default may be lowercase. */
export function isGlassesLinkLayerBusy(connectionState: string | undefined): boolean {
  const u = (connectionState ?? "").toUpperCase()
  return u === "CONNECTING" || u === "SCANNING" || u === "BONDING"
}

interface GlassesState extends GlassesStatus {
  wifiStatusKnown: boolean
  wifiConnected: boolean
  wifiSsid: string
  wifiLocalIp: string
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

type GlassesInfoUpdate = Partial<GlassesStatus> & LegacyWifiFields

function wifiFromLegacyFields(info: LegacyWifiFields): WifiStatus | null {
  if (info.wifiConnected === true) {
    const ssid = info.wifiSsid?.trim()
    const localIp = info.wifiLocalIp?.trim()
    return ssid && localIp ? {state: "connected", ssid, localIp} : {state: "unknown"}
  }
  if (info.wifiConnected === false) {
    return {state: "disconnected"}
  }
  return null
}

function derivedWifiFields(wifi: WifiStatus): LegacyWifiFields {
  if (wifi.state === "connected") {
    return {
      wifiConnected: true,
      wifiSsid: wifi.ssid,
      wifiLocalIp: wifi.localIp,
    }
  }
  return {
    wifiConnected: false,
    wifiSsid: "",
    wifiLocalIp: "",
  }
}

export const getGlasesInfoPartial = (state: GlassesStatus | GlassesStore) => {
  const wifi = state.wifi
  return {
    batteryLevel: state.batteryLevel,
    charging: state.charging,
    caseBatteryLevel: state.caseBatteryLevel,
    caseCharging: state.caseCharging,
    connected: state.connected,
    wifiConnected: wifi.state === "connected",
    wifiSsid: wifi.state === "connected" ? wifi.ssid : "",
    deviceModel: state.deviceModel,
    // Cloud GlassesInfo uses modelName, map from deviceModel so the cloud
    // knows which device is connected when it receives connection state updates
    modelName: state.deviceModel || null,
  }
}

interface GlassesStore extends GlassesStatus {
  mtkUpdatedThisSession: boolean
  wifiStatusKnown: boolean
  wifiConnected: boolean
  wifiSsid: string
  wifiLocalIp: string
  otaStatus: OtaStatus | null
}

const initialState: GlassesStore = {
  // state:
  fullyBooted: false,
  connected: false,
  micEnabled: false,
  connectionState: "disconnected",
  btcConnected: false,
  signalStrength: -1,
  signalStrengthUpdatedAt: 0,
  // device info
  deviceModel: "",
  androidVersion: "",
  fwVersion: "",
  btMacAddress: "",
  leftMacAddress: "",
  rightMacAddress: "",
  buildNumber: "",
  otaVersionUrl: "",
  appVersion: "",
  bluetoothName: "",
  serialNumber: "",
  style: "",
  color: "",
  mtkFwVersion: "",
  besFwVersion: "",
  // wifi info
  wifi: {state: "disconnected"},
  wifiConnected: false,
  wifiSsid: "",
  wifiLocalIp: "",
  wifiStatusKnown: false,
  // battery info
  batteryLevel: -1,
  charging: false,
  caseBatteryLevel: -1,
  caseCharging: false,
  caseOpen: false,
  caseRemoved: true,
  // hotspot info
  hotspotEnabled: false,
  hotspotSsid: "",
  hotspotPassword: "",
  hotspotGatewayIp: "",
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
        const {wifiConnected, wifiSsid, wifiLocalIp, ...sdkInfo} = info
        const wifiUpdate = info.wifi ?? wifiFromLegacyFields({wifiConnected, wifiSsid, wifiLocalIp})
        const hasWifiInfoUpdate =
          Object.prototype.hasOwnProperty.call(info, "wifi") ||
          Object.prototype.hasOwnProperty.call(info, "wifiConnected") ||
          Object.prototype.hasOwnProperty.call(info, "wifiSsid") ||
          Object.prototype.hasOwnProperty.call(info, "wifiLocalIp")
        const next = {
          ...state,
          ...sdkInfo,
          ...(wifiUpdate ? {wifi: wifiUpdate, ...derivedWifiFields(wifiUpdate)} : {}),
          ...(hasWifiInfoUpdate ? {wifiStatusKnown: true} : {}),
        }
        if (next.connected === false) {
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
      set({
        wifi: connected ? {state: "unknown"} : {state: "disconnected"},
        wifiConnected: connected,
        wifiSsid: ssid,
        wifiLocalIp: "",
        wifiStatusKnown: true,
      }),

    setHotspotInfo: (enabled: boolean, ssid: string, password: string, ip: string) =>
      set({
        hotspotEnabled: enabled,
        hotspotSsid: ssid,
        hotspotPassword: password,
        hotspotGatewayIp: ip,
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
