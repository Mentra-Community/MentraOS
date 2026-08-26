/// <reference types="bun-types" />

import React from "react"
import TestRenderer, {act} from "react-test-renderer"
import {beforeEach, describe, expect, mock, test} from "bun:test"

import type {OtaInstallSnapshot} from "../../services/OtaInstallCoordinator"
import type {OtaCheckCurrentGlassesResult} from "../../services/OtaUpdateCheckService"
;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true

const checkResult: OtaCheckCurrentGlassesResult = {
  hasCheckCompleted: true,
  updateAvailable: true,
  latestVersionInfo: {
    versionCode: 40,
    versionName: "3.1.0-dev.8",
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
  updateInfo: {available: true, versionCode: 40, versionName: "3.1.0-dev.8", updates: ["apk"], totalSize: 1},
  isRequired: true,
}
let currentCheckResult = checkResult

let otaSnapshot = {
  connected: true,
  buildNumber: "39",
  appVersion: "3.0.0",
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
const getReleaseChangelogs = mock(() => [{version: "3.1.0", markdown: "Release notes"}])
let autoChainActive = false
let autoChainRange: {fromVersion: string | null; toVersion: string | null} | null = null
const beginAutoChain = mock(
  (
    _fingerprint: string,
    _approvedDowngrade: boolean,
    range: {fromVersion: string | null; toVersion: string | null},
  ) => {
    autoChainActive = true
    autoChainRange = {...range}
  },
)
const stopAutoChain = mock(() => {
  autoChainActive = false
  autoChainRange = null
})
const advanceAutoChain = mock((_fingerprint: string, _isDowngrade: boolean, targetVersion: string | null) => {
  if (!autoChainRange) return {advance: false as const, reason: "inactive" as const}
  if (targetVersion) autoChainRange.toVersion = targetVersion
  return {advance: true as const, passCount: 2}
})

const fakeOta = {
  initialize: mock(() => Promise.resolve()),
  snapshot: () => otaSnapshot,
  onSnapshot: (listener: () => void) => {
    otaListeners.add(listener)
    return () => otaListeners.delete(listener)
  },
  checkForUpdates: mock(() => Promise.resolve(currentCheckResult)),
  getReleaseChangelogs,
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
  beginOtaAutoChain: beginAutoChain,
  clearOtaAutoChainReconnectWait: mock(() => {}),
  isOtaAutoChainActive: () => autoChainActive,
  otaAutoChainFingerprint: () => "fingerprint",
  otaAutoChainReleaseRange: () => (autoChainRange ? {...autoChainRange} : null),
  otaAutoChainReconnectWaitRemaining: () => null,
  stopOtaAutoChain: stopAutoChain,
  tryAdvanceOtaAutoChain: advanceAutoChain,
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
    getReleaseChangelogs.mockClear()
    fakeOta.checkForUpdates.mockClear()
    beginAutoChain.mockClear()
    stopAutoChain.mockClear()
    advanceAutoChain.mockClear()
    autoChainActive = false
    autoChainRange = null
    currentCheckResult = checkResult
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

  test("exposes crossed release changelogs when an install completes", async () => {
    const renderer = await renderProbe("check")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_150))
    })
    expect(latestController.state.screen).toBe("update_available")

    await act(async () => {
      latestController.install()
    })
    installSnapshot = {...installSnapshot, displayState: "complete"}
    await act(async () => {
      installListeners.forEach((listener) => listener())
    })

    expect(getReleaseChangelogs).toHaveBeenCalledWith("3.0.0", "3.1.0-dev.8")
    expect(latestController.state.changelogs).toEqual([{version: "3.1.0", markdown: "Release notes"}])
    await act(async () => renderer.unmount())
  })

  test("keeps the release range across a progress-screen remount", async () => {
    const checkRenderer = await renderProbe("check")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_150))
    })
    await act(async () => latestController.install())
    await act(async () => checkRenderer.unmount())

    installSnapshot = {...installSnapshot, displayState: "complete"}
    const progressRenderer = await renderProbe("progress")
    expect(getReleaseChangelogs).toHaveBeenCalledWith("3.0.0", "3.1.0-dev.8")
    expect(latestController.state.changelogs).toEqual([{version: "3.1.0", markdown: "Release notes"}])
    await act(async () => progressRenderer.unmount())
  })

  test("retains changelogs on the final up-to-date screen", async () => {
    const renderer = await renderProbe("check")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_150))
    })
    await act(async () => latestController.install())
    currentCheckResult = {...checkResult, updateAvailable: false, updateInfo: null, updates: []}
    installSnapshot = {...installSnapshot, displayState: "complete"}
    await act(async () => {
      installListeners.forEach((listener) => listener())
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 800))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_150))
    })

    expect(latestController.state.screen).toBe("up_to_date")
    expect(latestController.state.changelogs).toEqual([{version: "3.1.0", markdown: "Release notes"}])
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
