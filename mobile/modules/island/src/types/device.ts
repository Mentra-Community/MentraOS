/**
 * Device connection state and metadata types
 * Used for POST /api/client/device/state
 */

export interface GlassesInfo {
  // Connection state
  connected: boolean

  // Device identification
  modelName: string | null
  androidVersion?: string
  fwVersion?: string
  buildNumber?: string
  otaVersionUrl?: string
  appVersion?: string
  bluetoothName?: string
  serialNumber?: string
  style?: string
  color?: string

  // WiFi info (only for WiFi-capable devices)
  wifiConnected?: boolean
  wifiSsid?: string
  wifiLocalIp?: string

  // Battery info
  batteryLevel?: number
  charging?: boolean
  caseBatteryLevel?: number
  caseCharging?: boolean
  caseOpen?: boolean
  caseRemoved?: boolean

  // Hotspot info
  hotspotEnabled?: boolean
  hotspotSsid?: string
  hotspotPassword?: string
  hotspotGatewayIp?: string

  // Metadata
  timestamp?: string
}
