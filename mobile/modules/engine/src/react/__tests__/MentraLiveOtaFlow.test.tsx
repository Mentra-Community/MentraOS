import {createRequire} from "node:module"
import {expect, mock, test} from "bun:test"
import TestRenderer, {act} from "react-test-renderer"
import type {MentraLiveOtaState} from "../../devices/mentra-live/types"

const rendererRequire = createRequire(require.resolve("react-test-renderer"))
const React = rendererRequire("react") as typeof import("react")
mock.module("react", () => React)
mock.module("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Text: "Text",
  View: "View",
  StyleSheet: {create: (styles: unknown) => styles},
}))
mock.module("react-native-safe-area-context", () => ({SafeAreaView: "SafeAreaView"}))
mock.module("react-native-marked", () => ({useMarkdown: () => []}))
mock.module("react-native-svg", () => ({default: "Svg", Path: "Path", Rect: "Rect"}))
mock.module("../useMentraLiveOta", () => ({
  MINIMUM_OTA_BATTERY_LEVEL: 25,
  useMentraLiveOta: () => {
    throw new Error("Preview must not open a device")
  },
}))
Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true})
const {MentraLiveOtaPreview} = await import("../MentraLiveOtaFlow")

const failed: MentraLiveOtaState = {
  screen: "failed",
  connected: true,
  batteryLevel: 60,
  transport: "wifi",
  updateRequired: true,
  versionChange: false,
  versionChangeConverged: false,
  versionChangePhase: null,
  wifiConnected: true,
  wifiStatusKnown: true,
  hotspotSupported: false,
  hotspotPhase: "idle",
  hotspotArtifactPercent: null,
  phase: "install",
  step: "bes",
  currentStep: 1,
  totalSteps: 1,
  progress: null,
  installingApkOnly: false,
  firmwareRestarting: false,
  error: {code: "bes_restart_required", message: "Restart your glasses to recover this update."},
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
  glassesPackageName: null,
}

test("stock failure screen preserves restart guidance without offering an unsafe Done action", async () => {
  let root!: TestRenderer.ReactTestRenderer
  await act(async () => {
    root = TestRenderer.create(React.createElement(MentraLiveOtaPreview, {state: failed}))
  })
  expect(root.root.findAllByProps({testID: "button-Done"})).toHaveLength(0)
  expect(root.root.findAllByProps({testID: "button-Retry"})).toHaveLength(0)
  expect(JSON.stringify(root.toJSON())).toContain(failed.error!.message)
  await act(async () => {
    root.update(React.createElement(MentraLiveOtaPreview, {state: {...failed, canFinish: true}}))
  })
  expect(root.root.findAllByProps({testID: "button-Done"})).toHaveLength(1)
  expect(root.root.findAllByProps({testID: "button-Retry"})).toHaveLength(0)
  await act(async () => {
    root.update(React.createElement(MentraLiveOtaPreview, {state: {...failed, canRetry: true}}))
  })
  expect(root.root.findAllByProps({testID: "button-Done"})).toHaveLength(0)
  expect(root.root.findAllByProps({testID: "button-Retry"})).toHaveLength(1)
  await act(async () => root.unmount())
})
