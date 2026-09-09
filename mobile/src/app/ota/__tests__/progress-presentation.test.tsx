import React from "react"
import {render} from "@testing-library/react-native"

import {MentraLiveOtaFlow} from "../../../../modules/engine/src/react/MentraLiveOtaFlow"
import * as otaHook from "../../../../modules/engine/src/react/useMentraLiveOta"

const baseState: otaHook.MentraLiveOtaState = {
  screen: "preparing_hotspot",
  connected: true,
  glassesPackageName: null,
  batteryLevel: 80,
  transport: "hotspot",
  updateRequired: true,
  versionChange: false,
  versionChangeConverged: false,
  versionChangePhase: null,
  wifiConnected: false,
  wifiStatusKnown: true,
  hotspotSupported: true,
  hotspotPhase: "downloading",
  hotspotArtifactPercent: 100,
  phase: null,
  step: null,
  currentStep: null,
  totalSteps: null,
  progress: null,
  installingApkOnly: false,
  firmwareRestarting: false,
  error: null,
  canInstall: false,
  canRetry: false,
  canFinish: false,
  canDismiss: false,
  canDiscard: false,
  canOpenWifiSetup: false,
  continueDisabled: false,
  completedUpdate: false,
  releaseTransition: null,
  changelogs: [],
}

let state: otaHook.MentraLiveOtaState
beforeEach(() => {
  state = {...baseState}
  jest.spyOn(otaHook, "useMentraLiveOta").mockImplementation(() => ({
    state,
    check: jest.fn(),
    retryCheck: jest.fn(),
    install: jest.fn(),
    retryInstall: jest.fn(),
    finish: jest.fn(),
    discard: jest.fn(),
    openWifiSetup: jest.fn(),
  }))
})
afterEach(() => jest.restoreAllMocks())
const flow = () => <MentraLiveOtaFlow onFinished={jest.fn()} onOpenWifiSetup={jest.fn()} />

test("identifies each phone download when its percentage starts over", () => {
  state.hotspotArtifact = {kind: "apk", index: 0, totalCount: 3}
  const screen = render(flow())
  expect(screen.getByText("Downloading update to phone...")).toBeDefined()
  expect(screen.getByText("File 1 of 3 · Glasses software")).toBeDefined()
  expect(screen.getByText("100%")).toBeDefined()

  state = {...state, hotspotArtifact: {kind: "mtk", index: 1, totalCount: 3}, hotspotArtifactPercent: null}
  screen.rerender(flow())
  expect(screen.getByText("File 2 of 3 · System firmware")).toBeDefined()
  expect(screen.queryByText("100%")).toBeNull()
  expect(screen.queryByText("0%")).toBeNull()

  state = {...state, hotspotArtifact: {kind: "bes", index: 2, totalCount: 3}, hotspotArtifactPercent: 5}
  screen.rerender(flow())
  expect(screen.getByText("File 3 of 3 · Bluetooth firmware")).toBeDefined()
  expect(screen.getByText("5%")).toBeDefined()
})

test.each([
  ["starting_hotspot", "Starting glasses hotspot..."],
  ["joining_hotspot", "Connecting phone to glasses..."],
  ["serving", "Starting update..."],
] as const)("labels %s and hides the previous download's progress", (phase, title) => {
  state.hotspotPhase = phase
  state.hotspotArtifact = {kind: "apk", index: 0, totalCount: 1}
  const screen = render(flow())
  expect(screen.getByText(title)).toBeDefined()
  expect(screen.queryByText("100%")).toBeNull()
  expect(screen.queryByText("File 1 of 1 · Glasses software")).toBeNull()
})

test.each([
  ["apk", "Glasses software"],
  ["mtk", "System firmware"],
  ["bes", "Bluetooth firmware"],
] as const)("distinguishes %s transfer from installation", (step, component) => {
  state = {...state, screen: "updating", phase: "download", step, currentStep: 2, totalSteps: 3, progress: 100}
  const screen = render(flow())
  expect(screen.getByText("Transferring update to glasses...")).toBeDefined()
  expect(screen.getByText(`Update 2 of 3 · ${component}`)).toBeDefined()
  expect(screen.getByText("100%")).toBeDefined()

  state = {...state, phase: "install", progress: 20}
  screen.rerender(flow())
  expect(screen.getByText("Installing update on glasses...")).toBeDefined()
  expect(screen.getByText(`Update 2 of 3 · ${component}`)).toBeDefined()
  expect(screen.getByText("20%")).toBeDefined()
  expect(screen.queryByText("Transferring update to glasses...")).toBeNull()
})

test("does not invent a step count for a legacy update", () => {
  state = {...state, screen: "updating", phase: "install", step: "bes", progress: 50}
  const screen = render(flow())
  expect(screen.getByText("Bluetooth firmware")).toBeDefined()
  expect(screen.queryByText(/Update \d of/)).toBeNull()
})

test("keeps APK-only installation indeterminate", () => {
  state = {...state, screen: "updating", phase: "install", step: "apk", installingApkOnly: true, progress: 0}
  const screen = render(flow())
  expect(screen.getByText("Installing update on glasses...")).toBeDefined()
  expect(screen.queryByText("0%")).toBeNull()
})

test("keeps the direct Wi-Fi download label", () => {
  state = {...state, screen: "updating", transport: "wifi", phase: "download", step: "apk", progress: 50}
  expect(render(flow()).getByText("Downloading...")).toBeDefined()
})
