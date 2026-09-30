import {MentraLiveOtaSession, type LiveOtaPorts} from "../../modules/engine/src/devices/mentra-live/session"
import {ota} from "../../modules/engine/src/facades/ota"
import type {OtaCheckCurrentGlassesResult} from "../../modules/engine/src/services/OtaUpdateCheckService"

export const offer: OtaCheckCurrentGlassesResult = {
  hasCheckCompleted: true,
  updateAvailable: true,
  latestVersionInfo: null,
  updates: ["apk"],
  mtkPatch: null,
  besVersion: null,
  isApkDowngrade: false,
  manifestBody: "{}",
  releaseVersion: "3.3.1",
  updateInfo: {available: true, versionCode: 33010001, versionName: "3.3.1", updates: ["apk"], totalSize: 1},
  isRequired: true,
  manifestUrl: "https://example.com/version.json",
  buildNumber: "33000001",
}
export const current: OtaCheckCurrentGlassesResult = {...offer, updateAvailable: false, updates: [], updateInfo: null}

export function fixture() {
  let device = {
    ...ota.snapshot(),
    connected: true,
    ready: true,
    batteryLevel: 50 as number | null,
    appVersion: "3.3.0",
    buildNumber: "33000001",
    wifiStatusKnown: true,
    wifiConnected: true,
  }
  let install = {...ota.installSession.snapshot(), connected: true, displayState: "starting" as const}
  const listeners = new Set<() => void>()
  const installListeners = new Set<() => void>()
  const ports: LiveOtaPorts = {
    initialize: jest.fn(async () => {}),
    snapshot: () => device,
    onSnapshot: (fn) => {
      const listener = () => fn(device)
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    checkForUpdates: jest.fn(async () => offer),
    getReleaseChangelogs: jest.fn(() => [{version: "3.3.1", markdown: "Notes"}]),
    clearProgress: jest.fn(),
    clearUpdateAvailable: jest.fn(),
    installSession: {
      ...ota.installSession,
      prepare: jest.fn(() => "wifi"),
      attach: jest.fn(),
      detach: jest.fn(),
      retry: jest.fn(),
      finish: jest.fn(async () => {}),
      discard: jest.fn(async () => {}),
      snapshot: () => install,
      onSnapshot: (fn) => {
        const listener = () => fn(install)
        installListeners.add(listener)
        return () => installListeners.delete(listener)
      },
    },
  }
  const session = new MentraLiveOtaSession(ports)
  return {
    session,
    ports,
    device: (patch: Partial<typeof device>) => {
      device = {...device, ...patch}
      listeners.forEach((fn) => fn())
    },
    install: (patch: Partial<ReturnType<typeof ota.installSession.snapshot>>) => {
      install = {...install, ...patch} as typeof install
      installListeners.forEach((fn) => fn())
    },
  }
}
