import {GlassesStatus, OtaProgress, OtaUpdateInfo} from "core"
import {create} from "zustand"
import {subscribeWithSelector} from "zustand/middleware"

interface GlassesState extends GlassesStatus {
  setGlassesInfo: (info: Partial<GlassesStatus>) => void
  setBatteryInfo: (batteryLevel: number, charging: boolean, caseBatteryLevel: number, caseCharging: boolean) => void
  setWifiInfo: (connected: boolean, ssid: string) => void
  setHotspotInfo: (enabled: boolean, ssid: string, password: string, ip: string) => void
  // OTA methods
  setOtaUpdateAvailable: (info: OtaUpdateInfo | null) => void
  setOtaProgress: (progress: OtaProgress | null) => void
  setOtaInProgress: (inProgress: boolean) => void
  setMtkUpdatedThisSession: (updated: boolean) => void
  clearOtaState: () => void
  reset: () => void
  mtkUpdatedThisSession: boolean
}

export const getGlasesInfoPartial = (state: GlassesStatus) => {
  return {
    batteryLevel: state.batteryLevel,
    charging: state.charging,
    caseBatteryLevel: state.caseBatteryLevel,
    caseCharging: state.caseCharging,
    connected: state.connected,
    wifiConnected: state.wifiConnected,
    wifiSsid: state.wifiSsid,
    deviceModel: state.deviceModel,
  }
}

interface GlassesStore extends GlassesStatus {
  mtkUpdatedThisSession: boolean
}

const initialState: GlassesStore = {
  // state:
  fullyBooted: false,
  connected: false,
  micEnabled: false,
  connectionState: "disconnected",
  btcConnected: false,
  // device info
  deviceModel: "",
  androidVersion: "",
  fwVersion: "",
  btMacAddress: "",
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
  wifiConnected: false,
  wifiSsid: "",
  wifiLocalIp: "",
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
  otaUpdateAvailable: null,
  otaProgress: null,
  otaInProgress: false,
  mtkUpdatedThisSession: false,
}

export const useGlassesStore = create<GlassesState>()(
  subscribeWithSelector((set) => ({
    ...initialState,

    setGlassesInfo: (info) =>
      set((state) => {
        const next = {...state, ...info}
        // When glasses disconnect, reset all glasses state to initial values
        // This prevents stale device info, firmware versions, battery, wifi, etc. from persisting
        // console.log("GLASSES: setGlassesInfo called with: next.connected =", next.connected)
        // if (next.connected === false) {
        //   return {...initialState, ...info}
        // }
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
        wifiConnected: connected,
        wifiSsid: ssid,
      }),

    setHotspotInfo: (enabled: boolean, ssid: string, password: string, ip: string) =>
      set({
        hotspotEnabled: enabled,
        hotspotSsid: ssid,
        hotspotPassword: password,
        hotspotGatewayIp: ip,
      }),

    // OTA methods
    setOtaUpdateAvailable: (info: OtaUpdateInfo | null) => set({otaUpdateAvailable: info}),

    setOtaProgress: (progress: OtaProgress | null) =>
      set((_state) => {
        // Auto-detect otaInProgress from status
        const otaInProgress = progress !== null && progress.status !== "FINISHED" && progress.status !== "FAILED"
        console.log("🔍 GLASSES STORE: setOtaProgress called with:", JSON.stringify(progress))
        console.log("🔍 GLASSES STORE: otaInProgress =", otaInProgress)
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

export const waitForGlassesState = <K extends keyof GlassesStatus>(
  key: K,
  predicate: (value: GlassesStatus[K]) => boolean,
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
