import {useState} from "react"

import BluetoothSdk from "../index"
import {
  DeviceModels,
  createDisconnectedGlassesStatus,
  isConnectedGlassesConnectionStatus,
  isReadyGlassesConnectionStatus,
} from "../BluetoothSdk.types"
import type {
  ConnectOptions,
  Device,
  DeviceModel,
  GlassesConnectionStatus,
  HotspotStatus,
  PublicBluetoothStatus,
  PublicGlassesStatus,
  MicMode,
  WifiSearchResult,
  WifiStatus,
} from "../BluetoothSdk.types"

import {
  useGlassesConnection,
  type DefaultDeviceStorage,
  type GlassesConnectionHookResult,
} from "./useGlassesConnection"

export type BatteryState = {
  charging: boolean
  level: number | null
}

export type ConnectedGlassesInfo = {
  appVersion?: string
  bluetoothName?: string
  buildNumber?: string
  color?: string
  deviceModel?: string
  firmwareVersion?: string
  serialNumber?: string
  style?: string
}

export type FirmwareInfo = {
  appVersion?: string
  buildNumber?: string
  source:
    | "app"
    | "bes"
    | "device"
    | "firmware"
    | "left"
    | "mtk"
    | "right"
    | "unknown"
  version: string | null
}

export type SignalState = {
  strengthDbm: number | null
  updatedAt: number | null
}

export type GlassesRuntimeState =
  | {
      connected: false
      connection: Exclude<GlassesConnectionStatus, {state: "connected"}>
      ready: false
    }
  | {
      battery: BatteryState
      connected: true
      connection: Extract<GlassesConnectionStatus, {state: "connected"}>
      device: ConnectedGlassesInfo
      firmware: FirmwareInfo
      hotspot: HotspotStatus
      ready: boolean
      signal: SignalState
      voiceActivityDetectionEnabled: boolean
      wifi: WifiStatus
    }

export type GalleryModeState = {
  applying: boolean
  enabled: boolean
  error: unknown | null
}

export type PhoneSdkRuntimeState = {
  currentMic: MicMode | null
  defaultDevice: Device | null
  galleryMode: GalleryModeState
  lastLog: string[]
  micRanking: MicMode[]
  otherBluetoothConnected: boolean
  searching: boolean
  searchingController: boolean
  systemMicUnavailable: boolean
  wifiScanResults: WifiSearchResult[]
}

export type ScanController = {
  active: boolean
  clear: () => void
  devices: Device[]
  error: unknown | null
  model: DeviceModel
  selectedDevice: Device | null
  selectDevice: (device: Device | null) => void
  setModel: (model: DeviceModel) => void
  start: (model?: DeviceModel) => Promise<Device[]>
  stop: () => Promise<void>
}

export type UseMentraBluetoothOptions = {
  autoConnectDefault?: boolean
  defaultDeviceStorage?: DefaultDeviceStorage
  defaultModel?: DeviceModel
  onError?: (error: unknown) => void
  scanTimeoutMs?: number
}

export type MentraBluetoothSession = {
  busy: boolean
  clearDefaultDevice: () => Promise<void>
  connect: (device?: Device, options?: ConnectOptions) => Promise<void>
  connectDefault: (options?: ConnectOptions) => Promise<void>
  defaultDevice: Device | null
  disconnect: () => Promise<void>
  error: unknown | null
  glasses: GlassesRuntimeState
  refresh: () => Promise<void>
  scan: ScanController
  sdk: PhoneSdkRuntimeState
  setDefaultDevice: (device: Device | null) => Promise<void>
  setGalleryModeEnabled: (enabled: boolean) => Promise<void>
  setVoiceActivityDetectionEnabled: (enabled: boolean) => Promise<void>
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function firmwareInfo(status: Partial<PublicGlassesStatus>): FirmwareInfo {
  const firmwareSources = [
    ["firmwareVersion", "firmware"],
    ["deviceFirmwareVersion", "device"],
    ["rightFirmwareVersion", "right"],
    ["leftFirmwareVersion", "left"],
    ["besFirmwareVersion", "bes"],
    ["mtkFirmwareVersion", "mtk"],
    ["appVersion", "app"],
  ] as const

  for (const [key, source] of firmwareSources) {
    const value = stringValue((status as Record<string, unknown>)[key])
    if (value) {
      return {
        appVersion: stringValue(status.appVersion),
        buildNumber: stringValue(status.buildNumber),
        source,
        version: value,
      }
    }
  }

  return {
    appVersion: stringValue(status.appVersion),
    buildNumber: stringValue(status.buildNumber),
    source: "unknown",
    version: null,
  }
}

function batteryState(status: Partial<PublicGlassesStatus>): BatteryState {
  const level = typeof status.batteryLevel === "number" && status.batteryLevel >= 0 ? status.batteryLevel : null
  return {
    charging: status.charging ?? false,
    level,
  }
}

function connectedGlassesInfo(status: Partial<PublicGlassesStatus>): ConnectedGlassesInfo {
  return {
    appVersion: stringValue(status.appVersion),
    bluetoothName: stringValue(status.bluetoothName),
    buildNumber: stringValue(status.buildNumber),
    color: stringValue(status.color),
    deviceModel: stringValue(status.deviceModel),
    firmwareVersion: stringValue(status.firmwareVersion),
    serialNumber: stringValue(status.serialNumber),
    style: stringValue(status.style),
  }
}

function runtimeGlassesState(status: Partial<PublicGlassesStatus>): GlassesRuntimeState {
  const connection = status.connection ?? createDisconnectedGlassesStatus().connection ?? {state: "disconnected"}

  if (!isConnectedGlassesConnectionStatus(connection)) {
    return {
      connected: false,
      connection,
      ready: false,
    }
  }

  return {
    battery: batteryState(status),
    connected: true,
    connection,
    device: connectedGlassesInfo(status),
    firmware: firmwareInfo(status),
    hotspot: status.hotspot ?? {state: "disabled"},
    ready: isReadyGlassesConnectionStatus(connection),
    signal: {
      strengthDbm: numberValue((status as Record<string, unknown>).signalStrength),
      updatedAt: numberValue((status as Record<string, unknown>).signalStrengthUpdatedAt),
    },
    voiceActivityDetectionEnabled: status.voiceActivityDetectionEnabled ?? true,
    wifi: status.wifi ?? {state: "disconnected"},
  }
}

function phoneSdkState(
  status: Partial<PublicBluetoothStatus>,
  defaultDevice: Device | null,
  galleryMode: GalleryModeState,
): PhoneSdkRuntimeState {
  return {
    currentMic: status.currentMic || null,
    defaultDevice,
    galleryMode,
    lastLog: status.lastLog ?? [],
    micRanking: status.micRanking ?? [],
    otherBluetoothConnected: status.otherBtConnected ?? false,
    searching: status.searching ?? false,
    searchingController: status.searchingController ?? false,
    systemMicUnavailable: status.systemMicUnavailable ?? false,
    wifiScanResults: status.wifiScanResults ?? [],
  }
}

function scanController(connection: GlassesConnectionHookResult): ScanController {
  return {
    active: connection.scan.scanning,
    clear: connection.scan.clearResults,
    devices: connection.scan.devices,
    error: connection.scan.error,
    model: connection.scan.model,
    selectedDevice: connection.scan.selectedDevice,
    selectDevice: connection.scan.selectDevice,
    setModel: connection.scan.setModel,
    start: connection.scan.startScan,
    stop: connection.scan.stopScan,
  }
}

export function useMentraBluetooth(options: UseMentraBluetoothOptions = {}): MentraBluetoothSession {
  const connection = useGlassesConnection({
    autoConnectDefault: options.autoConnectDefault,
    defaultDeviceStorage: options.defaultDeviceStorage,
    onError: options.onError,
    scanModel: options.defaultModel ?? DeviceModels.MentraLive,
    scanTimeoutMs: options.scanTimeoutMs,
  })
  const [galleryModeApplying, setGalleryModeApplying] = useState(false)
  const [galleryModeError, setGalleryModeError] = useState<unknown | null>(null)

  async function setGalleryModeEnabled(enabled: boolean) {
    setGalleryModeApplying(true)
    setGalleryModeError(null)
    try {
      await BluetoothSdk.setGalleryModeEnabled(enabled)
    } catch (error) {
      setGalleryModeError(error)
      options.onError?.(error)
      throw error
    } finally {
      setGalleryModeApplying(false)
    }
  }

  async function setVoiceActivityDetectionEnabled(enabled: boolean) {
    try {
      await BluetoothSdk.setVoiceActivityDetectionEnabled(enabled)
    } catch (error) {
      options.onError?.(error)
      throw error
    }
  }

  const galleryMode: GalleryModeState = {
    applying: galleryModeApplying,
    enabled: connection.bluetoothStatus.galleryModeEnabled !== false,
    error: galleryModeError,
  }

  return {
    busy: connection.busy || galleryModeApplying,
    clearDefaultDevice: connection.clearDefaultDevice,
    connect: connection.connect,
    connectDefault: connection.connectDefault,
    defaultDevice: connection.defaultDevice,
    disconnect: connection.disconnect,
    error: galleryModeError ?? connection.error,
    glasses: runtimeGlassesState(connection.glassesStatus),
    refresh: connection.refresh,
    scan: scanController(connection),
    sdk: phoneSdkState(connection.bluetoothStatus, connection.defaultDevice, galleryMode),
    setDefaultDevice: connection.setDefaultDevice,
    setGalleryModeEnabled,
    setVoiceActivityDetectionEnabled,
  }
}
