/// <reference types="bun-types" />

import React from "react"
import TestRenderer, {act} from "react-test-renderer"
import {beforeEach, describe, expect, mock, test} from "bun:test"

import type {OtaInstallSnapshot} from "../../services/OtaInstallCoordinator"
;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true

const checkResult = {
  hasCheckCompleted: true,
  updateAvailable: true,
  latestVersionInfo: {
    versionCode: 40,
    versionName: "40",
    downloadUrl: "https://example.com/asg.apk",
    apkSize: 1,
    sha256: "a".repeat(64),
    releaseNotes: "",
  },
  updates: ["apk"],
  mtkPatch: null,
  besVersion: null,
  isApkDowngrade: false,
  manifestBody: "{}",
  updateInfo: {available: true, versionCode: 40, versionName: "40", updates: ["apk"], totalSize: 1},
  isRequired: true,
}

let otaSnapshot = {
  connected: true,
  buildNumber: "39",
  mtkFirmwareVersion: "0801",
  besFirmwareVersion: "0808",
  hotspotOtaVersion: 1,
  wifiConnected: false,
  wifiStatusKnown: true,
  manifestUrl: "https://example.com/version.json",
  updateAvailable: null,
  status: null,
  legacyProgress: null,
  inProgress: false,
  mtkUpdatedThisSession: false,
}

let installSnapshot: OtaInstallSnapshot = {
  displayState: "starting" as const,
  errorMsg: "",
  continueButtonDisabled: false,
  connected: true,
  otaStatus: null,
  otaProgress: null,
  mtkInstallStallSimulatedPercent: null,
  isVersionChange: false,
  versionChangeConverged: false,
  versionChangePhase: null,
  hotspotPhase: "downloading" as const,
  hotspotArtifactPercent: 45,
  transport: "hotspot" as const,
}

const otaListeners = new Set<() => void>()
const installListeners = new Set<() => void>()
const prepare = mock(() => "hotspot" as const)
const attach = mock(() => {})
const detach = mock(() => {})
const retry = mock(() => {})
let finishPromise = Promise.resolve()
const finish = mock(() => finishPromise)
const discard = mock(() => {})
let autoChainActive = false

const fakeOta = {
  initialize: mock(() => Promise.resolve()),
  snapshot: () => otaSnapshot,
  onSnapshot: (listener: () => void) => {
    otaListeners.add(listener)
    return () => otaListeners.delete(listener)
  },
  checkForUpdates: mock(() => Promise.resolve(checkResult)),
  clearUpdateAvailable: mock(() => {}),
  clearProgress: mock(() => {}),
  installSession: {
    prepare,
    attach,
    detach,
    retry,
    finish,
    discard,
    snapshot: () => installSnapshot,
    onSnapshot: (listener: () => void) => {
      installListeners.add(listener)
      return () => installListeners.delete(listener)
    },
  },
}

mock.module("../../facades/ota", () => ({ota: fakeOta}))
mock.module("../../services/OtaAutoChain", () => ({
  beginOtaAutoChain: mock(() => {}),
  clearOtaAutoChainReconnectWait: mock(() => {}),
  isOtaAutoChainActive: () => autoChainActive,
  otaAutoChainFingerprint: () => "fingerprint",
  otaAutoChainReconnectWaitRemaining: () => null,
  stopOtaAutoChain: mock(() => {}),
  tryAdvanceOtaAutoChain: () => ({advance: false}),
}))
mock.module("../../services/OtaErrorMapping", () => ({
  BES_INSTALL_RESTART_MESSAGE: "Restart the glasses",
  getOtaErrorMessage: (error?: string) => error || "Install failed",
  shouldRequireGlassesRebootForBesFailure: () => false,
  shouldShowChangeWifiForOtaDownloadFailure: () => false,
}))

const {useMentraLiveOta} = require("../useMentraLiveOta") as typeof import("../useMentraLiveOta")

let latestController: ReturnType<typeof useMentraLiveOta>

function Probe({initialPage = "progress"}: {initialPage?: "check" | "progress"}) {
  latestController = useMentraLiveOta({initialPage, initializeRuntime: false})
  return null
}

async function renderProbe(initialPage: "check" | "progress" = "progress") {
  let renderer: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(<Probe initialPage={initialPage} />)
  })
  return renderer!
}

describe("useMentraLiveOta", () => {
  beforeEach(() => {
    otaListeners.clear()
    installListeners.clear()
    prepare.mockClear()
    attach.mockClear()
    detach.mockClear()
    retry.mockClear()
    finish.mockClear()
    discard.mockClear()
    fakeOta.checkForUpdates.mockClear()
    autoChainActive = false
    finishPromise = Promise.resolve()
    installSnapshot = {
      displayState: "starting",
      errorMsg: "",
      continueButtonDisabled: false,
      connected: true,
      otaStatus: null,
      otaProgress: null,
      mtkInstallStallSimulatedPercent: null,
      isVersionChange: false,
      versionChangeConverged: false,
      versionChangePhase: null,
      hotspotPhase: "downloading",
      hotspotArtifactPercent: 45,
      transport: "hotspot",
    }
  })

  test("projects hotspot staging and unified install progress without exposing stores", async () => {
    const renderer = await renderProbe()
    expect(attach).toHaveBeenCalledTimes(1)
    expect(latestController.state).toMatchObject({
      screen: "preparing_hotspot",
      transport: "hotspot",
      hotspotPhase: "downloading",
      hotspotArtifactPercent: 45,
    })

    installSnapshot = {
      ...installSnapshot,
      displayState: "updating",
      hotspotPhase: "serving",
      otaStatus: {
        sessionId: "session",
        totalSteps: 3,
        currentStep: 2,
        stepType: "mtk",
        phase: "install",
        stepPercent: 50,
        overallPercent: 60,
        status: "in_progress",
      },
    }
    await act(async () => {
      installListeners.forEach((listener) => listener())
    })

    expect(latestController.state).toMatchObject({
      screen: "updating",
      phase: "install",
      step: "mtk",
      currentStep: 2,
      totalSteps: 3,
      progress: 60,
    })
    await act(async () => renderer.unmount())
  })

  test("routes retry through the existing install coordinator", async () => {
    const renderer = await renderProbe()
    installSnapshot = {...installSnapshot, displayState: "failed", errorMsg: "Network lost"}
    await act(async () => {
      installListeners.forEach((listener) => listener())
    })

    expect(latestController.state).toMatchObject({
      screen: "failed",
      canRetry: true,
      error: {code: "install_failed", message: "Network lost"},
    })
    latestController.retryInstall()
    expect(retry).toHaveBeenCalledTimes(1)
    await act(async () => renderer.unmount())
  })

  test("keeps confirmed completion visible until hotspot teardown finishes", async () => {
    autoChainActive = true
    let resolveFinish!: () => void
    finishPromise = new Promise<void>((resolve) => {
      resolveFinish = resolve
    })
    const renderer = await renderProbe()
    installSnapshot = {...installSnapshot, displayState: "complete"}
    await act(async () => {
      installListeners.forEach((listener) => listener())
    })

    expect(latestController.state.screen).toBe("complete")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 800))
    })

    expect(finish).toHaveBeenCalledTimes(1)
    expect(fakeOta.checkForUpdates).not.toHaveBeenCalled()
    expect(latestController.state.screen).toBe("complete")

    await act(async () => {
      resolveFinish()
      await finishPromise
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(fakeOta.checkForUpdates).toHaveBeenCalledTimes(1)
    await act(async () => renderer.unmount())
  })
})
