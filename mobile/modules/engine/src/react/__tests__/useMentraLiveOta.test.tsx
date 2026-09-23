/// <reference types="bun-types" />

import {createRequire} from "node:module"

import TestRenderer, {act} from "react-test-renderer"
import {beforeEach, describe, expect, mock, test} from "bun:test"

import type {OtaInstallSnapshot} from "../../services/OtaInstallCoordinator"
import type {OtaCheckCurrentGlassesResult} from "../../services/OtaUpdateCheckService"

// Engine is a workspace member of both mobile/ and sdk/, so a bare `react`
// import here is the sdk copy while react-test-renderer binds the mobile copy.
// Load the hook against the renderer's React or every hook throws.
const rendererRequire = createRequire(require.resolve("react-test-renderer"))
mock.module("react", () => rendererRequire("react"))
mock.module("../../utils/timers", () => ({BgTimer: {setTimeout, clearTimeout, setInterval, clearInterval}}))
mock.module("../../devices/mentra-live/availabilityRuntime", () => ({stopLiveAvailability() {}}))
Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true})

const checkResult: OtaCheckCurrentGlassesResult = {
  hasCheckCompleted: true,
  updateAvailable: true,
  latestVersionInfo: {
    versionCode: 40,
    versionName: "asg.40",
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
  releaseVersion: "3.1.0-dev.8",
  updateInfo: {available: true, versionCode: 40, versionName: "asg.40", updates: ["apk"], totalSize: 1},
  isRequired: true,
}
let currentCheckResult = checkResult

let otaSnapshot = {
  connected: true,
  ready: true,
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
  hotspotArtifact: {kind: "mtk", index: 1, totalCount: 3, artifactPercent: 45, bytesWritten: 45, contentLength: 100},
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
let autoChainRange: {
  fromVersion: string | null
  toVersion: string | null
  releaseVersion?: string | null
} | null = null
const beginAutoChain = mock(
  (
    _fingerprint: string,
    _approvedDowngrade: boolean,
    range: {fromVersion: string | null; toVersion: string | null; releaseVersion?: string | null},
  ) => {
    autoChainActive = true
    autoChainRange = {...range}
  },
)
const stopAutoChain = mock(() => {
  autoChainActive = false
  autoChainRange = null
})
const advanceAutoChain = mock(
  (_fingerprint: string, _isDowngrade: boolean, targetVersion: string | null, releaseVersion: string | null) => {
    if (!autoChainRange) return {advance: false as const, reason: "inactive" as const}
    if (targetVersion) autoChainRange.toVersion = targetVersion
    if (releaseVersion) autoChainRange.releaseVersion = releaseVersion
    return {advance: true as const, passCount: 2}
  },
)

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

mock.module("../../devices/mentra-live/ports", () => ({liveOtaPorts: fakeOta}))
// This suite isolates Live's public hook; NIMO's native file transport is covered separately.
mock.module("../../devices/nimo/definition", () => ({nimoIntegration: {id: "nimo", models: ["NIMO"]}}))
mock.module("../../devices/ar99/definition", () => ({ar99Integration: {id: "ar99", models: ["AR99"]}}))
const getDefaultDevice = mock(async () => ({id: "live-test", model: "Mentra Live", name: "Live"}))
mock.module("@mentra/bluetooth-sdk", () => ({
  default: {
    getDefaultDevice,
    getFirmwareUpdateSnapshot: async () => {
      throw Object.assign(new Error("Older standalone SDK"), {code: "unsupported"})
    },
  },
}))
mock.module("../../services/OtaInstallCoordinator", () => ({otaInstallCoordinator: {isSafeToRelease: () => true}}))
mock.module("../../services/OtaAutoChain", () => ({
  createOtaAutoChain: () => ({
    beginOtaAutoChain: beginAutoChain,
    clearOtaAutoChainReconnectWait: () => {},
    isOtaAutoChainActive: () => autoChainActive,
    otaAutoChainReleaseRange: () => (autoChainRange ? {...autoChainRange} : null),
    otaAutoChainReconnectWaitRemaining: () => null,
    stopOtaAutoChain: stopAutoChain,
    tryAdvanceOtaAutoChain: advanceAutoChain,
  }),
  OTA_AUTO_CHAIN_RECONNECT_TIMEOUT_MS: 120_000,
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
  OTA_ERROR_BES_RESTART_REQUIRED_COPY_KEY: "ota:errorBesRestartRequired",
  getOtaErrorMessage: (error?: string | null) => (error ? `mapped:${error}` : "Install failed"),
  otaErrorCopyKey: (error?: string | null) => (error ? `ota:key:${error}` : "ota:errorGeneric"),
  shouldRequireGlassesRebootForBesFailure: () => false,
  shouldShowChangeWifiForOtaDownloadFailure: () => false,
}))

const {getMentraLiveOtaSession, releaseMentraLiveOtaSession} =
  require("../../devices/mentra-live/sessionRegistry") as typeof import("../../devices/mentra-live/sessionRegistry")

const {useMentraLiveOta} = require("../useMentraLiveOta") as typeof import("../useMentraLiveOta")
const {firmwareUpdateService} =
  require("../../facades/firmwareUpdates") as typeof import("../../facades/firmwareUpdates")

let latestController: ReturnType<typeof useMentraLiveOta>
let renderedScreens: string[] = []

function Probe({initialPage = "progress", ...options}: Parameters<typeof useMentraLiveOta>[0] = {}) {
  latestController = useMentraLiveOta({initialPage, initializeRuntime: false, ...options})
  renderedScreens.push(latestController.state.screen)
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
  beforeEach(async () => {
    const previous = getMentraLiveOtaSession()
    if (previous) {
      finishPromise = Promise.resolve()
      previous.suspendNewWork()
      await previous.finishSuspendedWork()
      firmwareUpdateService.suspendNewWork()
      releaseMentraLiveOtaSession()
    }
    otaListeners.clear()
    installListeners.clear()
    prepare.mockClear()
    attach.mockClear()
    detach.mockClear()
    retry.mockClear()
    finish.mockClear()
    discard.mockClear()
    getReleaseChangelogs.mockClear()
    getReleaseChangelogs.mockImplementation(() => [{version: "3.1.0", markdown: "Release notes"}])
    fakeOta.checkForUpdates.mockClear()
    getDefaultDevice.mockReset().mockResolvedValue({id: "live-test", model: "Mentra Live", name: "Live"})
    beginAutoChain.mockClear()
    stopAutoChain.mockClear()
    advanceAutoChain.mockClear()
    renderedScreens = []
    autoChainActive = false
    autoChainRange = null
    currentCheckResult = checkResult
    otaSnapshot = {...otaSnapshot, appVersion: "3.0.0", connected: true, ready: true}
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
      hotspotArtifact: {
        kind: "mtk",
        index: 1,
        totalCount: 3,
        artifactPercent: 45,
        bytesWritten: 45,
        contentLength: 100,
      },
      transport: "hotspot",
    }
  })

  test("reports no artifact while runtime initialization is pending", async () => {
    let finishInitialization!: () => void
    fakeOta.initialize.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishInitialization = resolve
        }),
    )
    function InitializingProbe() {
      latestController = useMentraLiveOta({initializeRuntime: true})
      return null
    }
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(<InitializingProbe />)
    })
    expect(latestController.state.screen).toBe("initializing")
    expect(latestController.state.hotspotArtifact).toBeNull()
    await act(async () => {
      renderer!.unmount()
      finishInitialization()
    })
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
    expect(latestController.state.hotspotArtifact).toEqual({kind: "mtk", index: 1, totalCount: 3})

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
      // Phone-side watchdog copy is English-only: no copy key, and no glasses code to show.
      error: {code: "install_failed", message: "Network lost", copyKey: null, glassesCode: null},
    })
    await act(async () => latestController.retryInstall())
    expect(retry).toHaveBeenCalledTimes(1)
    await act(async () => renderer.unmount())
  })

  test("maps a glasses failure code to copy and keeps the raw code for support", async () => {
    const renderer = await renderProbe()
    installSnapshot = {
      ...installSnapshot,
      displayState: "failed",
      errorMsg: "",
      otaStatus: {
        sessionId: "s1",
        totalSteps: 1,
        currentStep: 1,
        stepType: "apk",
        phase: "install",
        stepPercent: 0,
        overallPercent: 0,
        status: "failed",
        error: "downgrade_handoff_failed",
      },
    }
    await act(async () => {
      installListeners.forEach((listener) => listener())
    })

    expect(latestController.state).toMatchObject({
      screen: "failed",
      canRetry: true,
      error: {
        code: "install_failed",
        message: "mapped:downgrade_handoff_failed",
        copyKey: "ota:key:downgrade_handoff_failed",
        glassesCode: "downgrade_handoff_failed",
      },
    })
    await act(async () => renderer.unmount())
  })

  test("does not let a host finish while glasses are still restarting", async () => {
    autoChainActive = true
    autoChainRange = {
      fromVersion: "3.0.0",
      toVersion: "3.1.0-dev.8",
      releaseVersion: "3.1.0-dev.8",
    }
    installSnapshot = {...installSnapshot, connected: false, displayState: "restarting"}
    const renderer = await renderProbe()

    expect(latestController.state).toMatchObject({screen: "restarting", canFinish: false})
    await act(async () => {
      await latestController.finish()
    })

    expect(finish).not.toHaveBeenCalled()
    expect(stopAutoChain).not.toHaveBeenCalled()
    expect(latestController.state.screen).toBe("restarting")
    await act(async () => renderer.unmount())
  })

  test("treats an active pass completion as a continuation check", async () => {
    const renderer = await renderProbe("check")
    expect(latestController.state.hotspotArtifact).toBeNull()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_150))
    })
    expect(latestController.state.screen).toBe("update_available")
    expect(latestController.state.releaseTransition).toEqual({
      fromVersion: "3.0.0",
      toVersion: "3.1.0-dev.8",
    })

    await act(async () => {
      latestController.install()
    })
    installSnapshot = {...installSnapshot, displayState: "complete"}
    await act(async () => {
      installListeners.forEach((listener) => listener())
    })

    expect(latestController.state.screen).toBe("finishing")
    expect(latestController.state.releaseTransition).toEqual({
      fromVersion: "3.0.0",
      toVersion: "3.1.0-dev.8",
    })
    expect(latestController.state.changelogs).toEqual([])
    expect(latestController.state.canFinish).toBe(false)
    expect(getReleaseChangelogs).not.toHaveBeenCalled()
    await act(async () => renderer.unmount())
  })

  test("keeps one version check in flight across connection snapshot updates", async () => {
    let resolveCheck!: (result: OtaCheckCurrentGlassesResult) => void
    fakeOta.checkForUpdates.mockImplementationOnce(
      () =>
        new Promise<OtaCheckCurrentGlassesResult>((resolve) => {
          resolveCheck = resolve
        }),
    )
    otaSnapshot = {...otaSnapshot, connected: true, ready: true, wifiStatusKnown: true}
    const renderer = await renderProbe("check")

    otaSnapshot = {...otaSnapshot, ready: false, wifiStatusKnown: false}
    await act(async () => otaListeners.forEach((listener) => listener()))
    otaSnapshot = {...otaSnapshot, ready: true, wifiStatusKnown: true}
    await act(async () => otaListeners.forEach((listener) => listener()))

    expect(fakeOta.checkForUpdates).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveCheck(checkResult)
      await new Promise((resolve) => setTimeout(resolve, 1_150))
    })

    expect(fakeOta.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(latestController.state.screen).toBe("update_available")
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
    expect(latestController.state.screen).toBe("finishing")
    expect(latestController.state.releaseTransition?.toVersion).toBe("3.1.0-dev.8")
    expect(latestController.state.changelogs).toEqual([])
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
    expect(latestController.state.completedUpdate).toBe(true)
    expect(latestController.state.releaseTransition).toEqual({
      fromVersion: "3.0.0",
      toVersion: "3.1.0-dev.8",
    })
    expect(latestController.state.changelogs).toEqual([{version: "3.1.0", markdown: "Release notes"}])
    await act(async () => renderer.unmount())
  })

  test("does not invent a coordinated target for a legacy manifest", async () => {
    currentCheckResult = {...checkResult, releaseVersion: null}
    const renderer = await renderProbe("check")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_150))
    })

    expect(latestController.state).toMatchObject({
      screen: "update_available",
      releaseTransition: null,
    })
    await act(async () => renderer.unmount())
  })

  test("keeps one approved flow open through legacy rescue and the remaining release updates", async () => {
    currentCheckResult = {...checkResult, buildNumber: "37", releaseVersion: null, updates: ["mtk", "bes"]}
    const renderer = await renderProbe("check")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_150))
    })
    await act(async () => latestController.install())

    let resolveHandoff!: (result: OtaCheckCurrentGlassesResult) => void
    fakeOta.checkForUpdates.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHandoff = resolve
        }),
    )
    installSnapshot = {...installSnapshot, displayState: "complete"}
    await act(async () => installListeners.forEach((listener) => listener()))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 800))
    })
    expect(fakeOta.checkForUpdates).toHaveBeenLastCalledWith(
      expect.objectContaining({waitForLegacyMigrationMs: 120_000}),
    )
    expect(latestController.state.screen).toBe("finishing")
    expect(latestController.state.completedUpdate).toBe(false)
    expect(latestController.state.canFinish).toBe(false)

    // The check remains pending while the legacy client hands off. ASG 39 then
    // selects the release pin, revealing the remaining APK and BES updates.
    installSnapshot = {...installSnapshot, displayState: "updating"}
    await act(async () => {
      installListeners.forEach((listener) => listener())
      resolveHandoff({...checkResult, buildNumber: "39", updates: ["apk", "bes"]})
      await new Promise((resolve) => setTimeout(resolve, 1_150))
    })
    expect(latestController.state.screen).toBe("updating")
    expect(prepare).toHaveBeenCalledTimes(2)
    expect(beginAutoChain).toHaveBeenCalledTimes(1)
    expect(stopAutoChain).not.toHaveBeenCalled()
    expect(renderedScreens).not.toContain("complete")
    expect(renderedScreens).not.toContain("up_to_date")

    currentCheckResult = {
      ...checkResult,
      buildNumber: "301010001",
      updateAvailable: false,
      updateInfo: null,
      updates: [],
    }
    installSnapshot = {...installSnapshot, displayState: "complete"}
    await act(async () => installListeners.forEach((listener) => listener()))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 800))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_150))
    })
    expect(latestController.state).toMatchObject({screen: "up_to_date", completedUpdate: true})
    expect(stopAutoChain).toHaveBeenCalledTimes(1)
    await act(async () => renderer.unmount())
  }, 10_000)

  test("retains release verification on Retry after a legacy handoff timeout", async () => {
    autoChainActive = true
    currentCheckResult = {...checkResult, hasCheckCompleted: false, checkFailureReason: "version_info"}
    const renderer = await renderProbe("check")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_150))
    })
    expect(latestController.state).toMatchObject({screen: "check_failed", completedUpdate: false, canRetry: true})
    expect(latestController.state.error).toMatchObject({
      copyKey: "ota:versionInfoFailedMessage",
      message: "Couldn't read the glasses software versions. Keep the glasses connected and try again.",
    })
    expect(stopAutoChain).not.toHaveBeenCalled()
    await act(async () => latestController.retryCheck())
    expect(fakeOta.checkForUpdates).toHaveBeenLastCalledWith(
      expect.objectContaining({waitForLegacyMigrationMs: 120_000}),
    )
    await act(async () => renderer.unmount())
  })

  test("reports completed session independently of an optional release label", async () => {
    currentCheckResult = {...checkResult, releaseVersion: null}
    const renderer = await renderProbe("check")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_150))
    })
    await act(async () => latestController.install())
    currentCheckResult = {...checkResult, updateAvailable: false, updateInfo: null, updates: [], releaseVersion: null}
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

    expect(latestController.state).toMatchObject({
      screen: "up_to_date",
      completedUpdate: true,
      releaseTransition: null,
    })
    await act(async () => renderer.unmount())
  })

  test("falls back to target notes when legacy glasses report a numeric version", async () => {
    otaSnapshot = {...otaSnapshot, appVersion: "40"}
    getReleaseChangelogs.mockImplementation((fromVersion) => {
      if (fromVersion === "40") throw new Error("legacy version is not coordinated semver")
      return [{version: "3.1.0", markdown: "Release notes"}]
    })
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

    expect(getReleaseChangelogs).toHaveBeenCalledWith("40", "3.1.0-dev.8")
    expect(getReleaseChangelogs).toHaveBeenCalledWith(null, "3.1.0-dev.8")
    expect(latestController.state).toMatchObject({
      screen: "up_to_date",
      changelogs: [{version: "3.1.0", markdown: "Release notes"}],
    })
    await act(async () => renderer.unmount())
  })

  test("keeps finishing visible until Wi-Fi status can resume an approved session", async () => {
    autoChainActive = true
    autoChainRange = {
      fromVersion: "3.0.0",
      toVersion: "3.1.0-dev.8",
      releaseVersion: "3.1.0-dev.8",
    }
    otaSnapshot = {...otaSnapshot, hotspotOtaVersion: 0, wifiConnected: false, wifiStatusKnown: false}
    const renderer = await renderProbe("check")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_150))
    })

    expect(latestController.state.screen).toBe("finishing")
    expect(renderedScreens).not.toContain("update_available")
    expect(stopAutoChain).not.toHaveBeenCalled()
    expect(advanceAutoChain).not.toHaveBeenCalled()

    otaSnapshot = {...otaSnapshot, wifiStatusKnown: true}
    await act(async () => {
      otaListeners.forEach((listener) => listener())
    })

    expect(latestController.state).toMatchObject({
      screen: "wifi_required",
      canDismiss: false,
      releaseTransition: {fromVersion: "3.0.0", toVersion: "3.1.0-dev.8"},
    })

    otaSnapshot = {...otaSnapshot, wifiConnected: true}
    await act(async () => {
      otaListeners.forEach((listener) => listener())
    })

    expect(advanceAutoChain).toHaveBeenCalledTimes(1)
    expect(beginAutoChain).not.toHaveBeenCalled()
    expect(fakeOta.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(prepare).toHaveBeenCalledWith(currentCheckResult)
    expect(latestController.state.screen).toBe("preparing_hotspot")
    await act(async () => renderer.unmount())
  })

  test("waits for the restarted ASG client to be fully ready before checking the next pass", async () => {
    autoChainActive = true
    autoChainRange = {
      fromVersion: "3.0.0",
      toVersion: "3.1.0-dev.8",
      releaseVersion: "3.1.0-dev.8",
    }
    otaSnapshot = {...otaSnapshot, connected: true, ready: false}
    const renderer = await renderProbe("check")

    expect(latestController.state.screen).toBe("finishing")
    expect(fakeOta.checkForUpdates).not.toHaveBeenCalled()

    otaSnapshot = {...otaSnapshot, ready: true}
    await act(async () => {
      otaListeners.forEach((listener) => listener())
      await new Promise((resolve) => setTimeout(resolve, 1_150))
    })

    expect(fakeOta.checkForUpdates).toHaveBeenCalledTimes(1)
    await act(async () => renderer.unmount())
  })

  test("keeps continuation checking visible until hotspot teardown finishes", async () => {
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

    expect(latestController.state.screen).toBe("finishing")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 800))
    })

    expect(finish).toHaveBeenCalledTimes(1)
    expect(fakeOta.checkForUpdates).not.toHaveBeenCalled()
    expect(latestController.state.screen).toBe("finishing")
    const screenCountBeforeReturn = renderedScreens.length

    await act(async () => {
      resolveFinish()
      await finishPromise
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(fakeOta.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(renderedScreens.slice(screenCountBeforeReturn)).not.toContain("update_available")
    await act(async () => renderer.unmount())
  })

  for (const entryPoint of ["pairing", "settings"] as const) {
    test.each(["resolution", "validation"])(
      `${entryPoint} failed %s closes safely without completing required setup`,
      async (failure) => {
        if (failure === "validation")
          getDefaultDevice.mockResolvedValueOnce({id: "live-test", model: "Mentra Live", name: "Live"})
        getDefaultDevice.mockRejectedValueOnce(new Error("Device lookup failed"))
        const onFinished = mock((_result?: import("../../ota/types").FirmwareFinishResult) => {})
        let view!: TestRenderer.ReactTestRenderer
        await act(async () => {
          view = TestRenderer.create(<Probe initialPage="check" entryPoint={entryPoint} onFinished={onFinished} />)
        })
        expect(latestController.state.screen).toBe("check_failed")
        expect(latestController.state.canDismiss).toBe(true)
        await act(async () => latestController.finish())
        expect(onFinished).toHaveBeenCalledTimes(1)
        expect(onFinished).toHaveBeenCalledWith(
          entryPoint === "pairing" ? {kind: "finished", outcome: "cancelled"} : undefined,
        )
        expect(firmwareUpdateService.retainedSnapshots()).toEqual([])
        await act(async () => view.unmount())
        latestController.finish()
        expect(onFinished).toHaveBeenCalledTimes(1)
      },
    )
  }

  test("failed Live opening cannot close over retained native ownership", async () => {
    getDefaultDevice.mockRejectedValueOnce(new Error("Device lookup failed"))
    const owner = {integrationId: "nimo", deviceId: "retained-owner"}
    firmwareUpdateService.noteNativeRecovery(owner, false)
    const onFinished = mock(() => {})
    let view!: TestRenderer.ReactTestRenderer
    await act(async () => {
      view = TestRenderer.create(<Probe initialPage="check" entryPoint="settings" onFinished={onFinished} />)
    })
    await act(async () => latestController.finish())
    expect(onFinished).not.toHaveBeenCalled()
    expect(latestController.state.error?.message).toContain("wait before disconnecting")
    firmwareUpdateService.noteNativeRecovery(owner, true)
    await act(async () => latestController.finish())
    expect(onFinished).toHaveBeenCalledTimes(1)
    await act(async () => view.unmount())
  })
})
