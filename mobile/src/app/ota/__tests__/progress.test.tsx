import {render, act, fireEvent} from "@testing-library/react-native"

// eslint-disable-next-line no-restricted-imports -- Use the real Engine store, not the public test mock.
import {useGlassesStore} from "../../../../modules/engine/src/stores/glasses"
// eslint-disable-next-line no-restricted-imports -- Share the same real settings store as the Engine hooks.
import {useSettingsStore} from "../../../../modules/engine/src/stores/settings"
import {useNavigationStore} from "@/stores/navigation"

import {useConnectionOverlayConfig} from "@/contexts/ConnectionOverlayContext"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"

import {initI18n} from "@/i18n"

import OtaProgressScreen from "@/app/ota/progress"
// eslint-disable-next-line no-restricted-imports -- Exercise the real retained session behind the public test mock.
import {
  getMentraLiveOtaSession,
  resolveMentraLiveOtaProvider,
  releaseMentraLiveOtaSession,
} from "../../../../modules/engine/src/devices/mentra-live/sessionRegistry"
import {BES_RESTART_TIMEOUT_MS, MINIMUM_OTA_STATUS_BUILD, OtaProgressMessages} from "@mentra/engine"
import {BES_INSTALL_RESTART_MESSAGE} from "@/utils/otaErrorMapping"

const mockReplace = jest.fn()
const AUTO_CHAIN_RELEASE_RANGE = {fromVersion: "3.0.0", toVersion: "3.1.0-dev.1"}
async function beginOtaAutoChain(fingerprint: string, downgrade: boolean, range: typeof AUTO_CHAIN_RELEASE_RANGE) {
  const provider = await resolveMentraLiveOtaProvider()
  provider.session.chain.beginOtaAutoChain(fingerprint, downgrade, range)
}
const isOtaAutoChainActive = () => getMentraLiveOtaSession()?.chain.isOtaAutoChainActive() ?? false
const stopOtaAutoChain = () => getMentraLiveOtaSession()?.chain.stopOtaAutoChain()

// super_mode is controlled through the REAL settings store — the screen's
// useSetting comes from the global @mentra/engine mock, which passes the real
// store-backed hook through.
const setSuperMode = (enabled: boolean) => useSettingsStore.getState().setSetting("super_mode", enabled, false)

jest.mock("@/contexts/NavigationHistoryContext", () => ({
  focusEffectLockScreen: jest.fn(),
  focusEffectPreventBack: jest.fn(),
  useNavigationHistory: () => ({replace: mockReplace}),
}))

jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({
    theme: {
      colors: {
        primary: "#000",
        foreground: "#000",
        textDim: "#888",
        border: "#ccc",
        error: "#f00",
      },
    },
  }),
}))

jest.mock("@/components/brands/MentraLogoStandalone", () => ({
  MentraLogoStandalone: () => null,
}))

// NOTE: @/utils/GlobalEventEmitter is intentionally NOT re-mocked here — the shim
// resolves to the shared island emitter instance, which is the one the island
// OtaInstallCoordinator listens on for ota_start_ack / mtk_update_complete.

jest.mock("@/components/ignite", () => {
  const {View, Text: RNText, TouchableOpacity} = require("react-native")
  const React = require("react")
  return {
    Screen: ({children}: any) => React.createElement(View, {testID: "screen"}, children),
    Header: () => null,
    Button: ({text, onPress}: any) =>
      React.createElement(
        TouchableOpacity,
        {testID: `button-${text}`, onPress},
        React.createElement(RNText, null, text),
      ),
    Text: ({text}: any) => React.createElement(RNText, null, text),
    Icon: () => null,
  }
})

const sb = (n: number) => String(n)

const BluetoothSdk = require("@mentra/bluetooth-sdk-internal").default

function connectedGlassesInfo(values = {}) {
  return {connection: {state: "connected", fullyBooted: true} as const, ...values}
}

function setGlassesConnected() {
  useGlassesStore.getState().setGlassesInfo(connectedGlassesInfo())
}

function setGlassesDisconnected() {
  useGlassesStore.getState().setGlassesInfo({connection: {state: "disconnected"}})
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  jest.useFakeTimers()
  BluetoothSdk.getDefaultDevice.mockReturnValue({id: "live-progress-fixture", model: "Mentra Live", name: "Live"})
  useSettingsStore.getState().setSetting("default_wearable", "Mentra Live", false)
  setSuperMode(false)
  useGlassesStore.getState().reset()
  useConnectionOverlayConfig.getState().clearConfig()
  mockReplace.mockClear()
  BluetoothSdk.queryOtaStatus.mockClear()
  BluetoothSdk.startOtaUpdate.mockReset().mockResolvedValue(undefined)
  stopOtaAutoChain()
})

afterEach(async () => {
  // Each test is a separate native lifetime. End the simulated transaction explicitly;
  // unmount alone intentionally no longer destroys the headless provider.
  await act(async () => {
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    stopOtaAutoChain()
    useGlassesStore.getState().setOtaStatus({
      sessionId: "test-end",
      totalSteps: 1,
      currentStep: 1,
      stepType: "apk",
      phase: "install",
      stepPercent: 0,
      overallPercent: 0,
      status: "failed",
    })
  })
  releaseMentraLiveOtaSession()
  jest.useRealTimers()
})

async function renderProgress() {
  const view = render(<OtaProgressScreen />)
  await act(async () => {})
  return view
}

describe("progress.tsx display states", () => {
  it("starts in starting state", async () => {
    setGlassesConnected()
    const {getByText} = await renderProgress()
    expect(getByText("Starting update…")).toBeDefined()
  })

  it("transitions to updating on in_progress ota_status", async () => {
    setGlassesConnected()
    const {getByText} = await renderProgress()

    act(() => {
      useGlassesStore.getState().setOtaStatus({
        sessionId: "s1",
        totalSteps: 2,
        currentStep: 1,
        stepType: "apk",
        phase: "download",
        stepPercent: 25,
        overallPercent: 12,
        status: "in_progress",
      })
    })

    expect(getByText("Downloading…")).toBeDefined()
    expect(getByText("25%")).toBeDefined()
  })

  it("clamps displayed percent to 100 when overallPercent exceeds 100", async () => {
    setGlassesConnected()
    const {getByText} = await renderProgress()

    act(() => {
      useGlassesStore.getState().setOtaStatus({
        sessionId: "s1",
        totalSteps: 2,
        currentStep: 2,
        stepType: "bes",
        phase: "install",
        stepPercent: 100,
        overallPercent: 140,
        status: "in_progress",
      })
    })

    expect(getByText("100%")).toBeDefined()
  })

  it("transitions to complete on complete ota_status even when a target build is known in store", async () => {
    const nextBuild = MINIMUM_OTA_STATUS_BUILD + 1
    useGlassesStore.getState().setGlassesInfo(connectedGlassesInfo({buildNumber: sb(MINIMUM_OTA_STATUS_BUILD)}))
    useGlassesStore.getState().setOtaUpdateAvailable({
      available: true,
      versionCode: nextBuild,
      versionName: `${nextBuild}.0`,
      updates: ["apk"],
      totalSize: 0,
    })
    const {getByText} = await renderProgress()

    act(() => {
      useGlassesStore.getState().setOtaStatus({
        sessionId: "s1",
        totalSteps: 1,
        currentStep: 1,
        stepType: "apk",
        phase: "install",
        stepPercent: 100,
        overallPercent: 100,
        status: "complete",
      })
    })

    expect(getByText("Update complete!")).toBeDefined()
    expect(getByText("Done")).toBeDefined()
  })

  it("transitions to complete on complete ota_status when no target build is set", async () => {
    setGlassesConnected()
    const {getByText} = await renderProgress()

    act(() => {
      useGlassesStore.getState().setOtaStatus({
        sessionId: "s1",
        totalSteps: 1,
        currentStep: 1,
        stepType: "apk",
        phase: "install",
        stepPercent: 100,
        overallPercent: 100,
        status: "complete",
      })
    })

    expect(getByText("Update complete!")).toBeDefined()
    expect(getByText("Done")).toBeDefined()
  })

  it("automatically returns to update checking after a chained pass completes", async () => {
    setGlassesConnected()
    await beginOtaAutoChain("initial-offer", false, AUTO_CHAIN_RELEASE_RANGE)
    const replaceSpy = jest.spyOn(useNavigationStore.getState(), "replace")
    try {
      const {getByText, queryByText} = await renderProgress()

      act(() => {
        useGlassesStore.getState().setOtaStatus({
          sessionId: "s1",
          totalSteps: 1,
          currentStep: 1,
          stepType: "apk",
          phase: "install",
          stepPercent: 100,
          overallPercent: 100,
          status: "complete",
        })
      })

      expect(getByText("Finishing your update")).toBeDefined()
      expect(queryByText("Update complete!")).toBeNull()
      expect(replaceSpy).not.toHaveBeenCalledWith("/ota/check-for-updates")
      await act(async () => {
        await jest.advanceTimersByTimeAsync(750)
      })
      expect(getByText("Finishing your update")).toBeDefined()
      expect(useConnectionOverlayConfig.getState().suppressOverlay).toBe(false)
      expect(replaceSpy).not.toHaveBeenCalledWith("/ota/check-for-updates")
    } finally {
      replaceSpy.mockRestore()
    }
  })

  it("waits for a rebooting chained pass to reconnect before checking again", async () => {
    setGlassesDisconnected()
    await beginOtaAutoChain("initial-offer", false, AUTO_CHAIN_RELEASE_RANGE)
    useGlassesStore.getState().setOtaStatus({
      sessionId: "s1",
      totalSteps: 1,
      currentStep: 1,
      stepType: "apk",
      phase: "install",
      stepPercent: 100,
      overallPercent: 100,
      status: "complete",
    })
    const replaceSpy = jest.spyOn(useNavigationStore.getState(), "replace")
    try {
      const {getByText} = await renderProgress()

      await act(async () => {
        await jest.advanceTimersByTimeAsync(750)
      })
      expect(replaceSpy).not.toHaveBeenCalledWith("/ota/check-for-updates")

      act(() => {
        setGlassesConnected()
      })
      await act(async () => {
        await jest.advanceTimersByTimeAsync(750)
      })
      expect(getByText("Finishing your update")).toBeDefined()
      expect(replaceSpy).not.toHaveBeenCalledWith("/ota/check-for-updates")
    } finally {
      replaceSpy.mockRestore()
    }
  })

  it("reschedules chained navigation when a reboot starts during the success delay", async () => {
    setGlassesConnected()
    await beginOtaAutoChain("initial-offer", false, AUTO_CHAIN_RELEASE_RANGE)
    const replaceSpy = jest.spyOn(useNavigationStore.getState(), "replace")
    try {
      const {getByText} = await renderProgress()
      act(() => {
        useGlassesStore.getState().setOtaStatus({
          sessionId: "s1",
          totalSteps: 1,
          currentStep: 1,
          stepType: "apk",
          phase: "install",
          stepPercent: 100,
          overallPercent: 100,
          status: "complete",
        })
      })

      await act(async () => {
        await jest.advanceTimersByTimeAsync(300)
      })
      act(() => {
        setGlassesDisconnected()
      })
      await act(async () => {
        await jest.advanceTimersByTimeAsync(750)
      })
      expect(replaceSpy).not.toHaveBeenCalledWith("/ota/check-for-updates")

      act(() => {
        setGlassesConnected()
      })
      await act(async () => {
        await jest.advanceTimersByTimeAsync(750)
      })
      expect(getByText("Finishing your update")).toBeDefined()
      expect(replaceSpy).not.toHaveBeenCalledWith("/ota/check-for-updates")
    } finally {
      replaceSpy.mockRestore()
    }
  })

  it("keeps a chained BES reboot non-actionable until the glasses reconnect", async () => {
    setGlassesConnected()
    await beginOtaAutoChain("initial-offer", false, AUTO_CHAIN_RELEASE_RANGE)
    const {getByText, queryByTestId} = await renderProgress()

    act(() => {
      useGlassesStore.getState().setOtaStatus({
        sessionId: "s1",
        totalSteps: 1,
        currentStep: 1,
        stepType: "bes",
        phase: "install",
        stepPercent: 100,
        overallPercent: 100,
        status: "step_complete",
      })
    })

    expect(getByText(/^Restarting .+…$/)).toBeDefined()
    expect(
      getByText(
        "The update is installed. Keep your glasses nearby and leave this screen open while they finish starting.",
      ),
    ).toBeDefined()
    expect(getByText("We'll continue automatically when they're ready.")).toBeDefined()
    expect(queryByTestId("button-Continue")).toBeNull()

    await act(async () => {
      await jest.advanceTimersByTimeAsync(35_000)
    })
    expect(queryByTestId("button-Continue")).toBeNull()
    expect(isOtaAutoChainActive()).toBe(true)

    await act(async () => {
      await jest.advanceTimersByTimeAsync(BES_RESTART_TIMEOUT_MS - 35_000)
    })
    expect(getByText("Update Failed")).toBeDefined()
    expect(getByText(BES_INSTALL_RESTART_MESSAGE)).toBeDefined()
  })

  it("transitions to failed on failed ota_status with error", async () => {
    setGlassesConnected()
    const {getByText} = await renderProgress()

    act(() => {
      useGlassesStore.getState().setOtaStatus({
        sessionId: "s1",
        totalSteps: 1,
        currentStep: 1,
        stepType: "apk",
        phase: "download",
        stepPercent: 0,
        overallPercent: 0,
        status: "failed",
        error: "no_internet",
      })
    })

    expect(getByText("Update Failed")).toBeDefined()
    expect(getByText("Glasses Wi-Fi has no internet connection")).toBeDefined()
    expect(getByText("Retry")).toBeDefined()
  })

  it("stops automatic chaining when leaving a failed pass to change WiFi", async () => {
    setGlassesConnected()
    await beginOtaAutoChain("initial-offer", false, AUTO_CHAIN_RELEASE_RANGE)
    const pushSpy = jest.spyOn(useNavigationStore.getState(), "push")
    try {
      const {getByText} = await renderProgress()

      act(() => {
        useGlassesStore.getState().setOtaStatus({
          sessionId: "s1",
          totalSteps: 1,
          currentStep: 1,
          stepType: "apk",
          phase: "download",
          stepPercent: 0,
          overallPercent: 0,
          status: "failed",
          error: "no_internet",
        })
      })

      await act(async () => {
        fireEvent.press(getByText("Change Wi-Fi"))
      })

      expect(isOtaAutoChainActive()).toBe(false)
      expect(useConnectionOverlayConfig.getState().suppressOverlay).toBe(false)
      expect(pushSpy).toHaveBeenCalledWith("/wifi/scan", {
        firmwareReturn: "true",
        firmwareEntryPoint: "recovery",
        firmwareDeviceId: "live-progress-fixture",
        firmwareIntegrationId: "mentra-live",
      })
    } finally {
      pushSpy.mockRestore()
    }
  })

  it("restores overlay suppression when retrying after WiFi setup", async () => {
    setGlassesConnected()
    const {getByText} = await renderProgress()

    act(() => {
      useGlassesStore.getState().setOtaStatus({
        sessionId: "s1",
        totalSteps: 1,
        currentStep: 1,
        stepType: "apk",
        phase: "download",
        stepPercent: 0,
        overallPercent: 0,
        status: "failed",
        error: "no_internet",
      })
    })

    await act(async () => {
      fireEvent.press(getByText("Change Wi-Fi"))
    })
    expect(useConnectionOverlayConfig.getState().suppressOverlay).toBe(false)

    await act(async () => {
      fireEvent.press(getByText("Retry"))
    })
    expect(useConnectionOverlayConfig.getState().suppressOverlay).toBe(true)
  })

  it("requires a glasses restart for the existing generic BES install failure", async () => {
    setGlassesConnected()
    const {getByText, queryByText} = await renderProgress()

    act(() => {
      useGlassesStore.getState().setOtaStatus({
        sessionId: "s1",
        totalSteps: 1,
        currentStep: 1,
        stepType: "bes",
        phase: "install",
        stepPercent: 0,
        overallPercent: 0,
        status: "failed",
        error: "install_failed",
      })
    })

    expect(getByText(BES_INSTALL_RESTART_MESSAGE)).toBeDefined()
    expect(getByText("Done")).toBeDefined()
    expect(queryByText("Retry")).toBeNull()
  })

  it("explains a failed downgrade handoff instead of echoing the glasses code", async () => {
    setGlassesConnected()
    const {getByText, getByTestId, queryByText} = await renderProgress()

    act(() => {
      useGlassesStore.getState().setOtaStatus({
        sessionId: "s1",
        totalSteps: 1,
        currentStep: 1,
        stepType: "apk",
        phase: "install",
        stepPercent: 0,
        overallPercent: 0,
        status: "failed",
        error: "downgrade_handoff_failed",
      })
    })

    expect(getByText("Update Failed")).toBeDefined()
    expect(
      getByText("The recovery service on your glasses did not respond. Restart your glasses and try again."),
    ).toBeDefined()
    // The raw code stays visible for support, but only in the subdued secondary line.
    expect(getByTestId("ota-error-code").props.children).toBe("Error code: downgrade_handoff_failed")
    expect(queryByText("downgrade_handoff_failed")).toBeNull()
    expect(getByText("Retry")).toBeDefined()
  })

  it("falls back to generic glasses-error copy for an unknown code and keeps the code visible", async () => {
    setGlassesConnected()
    const {getByText, getByTestId} = await renderProgress()

    act(() => {
      useGlassesStore.getState().setOtaStatus({
        sessionId: "s1",
        totalSteps: 1,
        currentStep: 1,
        stepType: "apk",
        phase: "install",
        stepPercent: 0,
        overallPercent: 0,
        status: "failed",
        error: "brand_new_code",
      })
    })

    expect(getByText("Your glasses reported an unexpected error. Restart your glasses and try again.")).toBeDefined()
    expect(getByTestId("ota-error-code").props.children).toBe("Error code: brand_new_code")
  })

  it("shows disconnected state when not connected and not terminal", async () => {
    setGlassesDisconnected()
    const {getByText} = await renderProgress()
    expect(getByText("Glasses disconnected")).toBeDefined()
  })

  it("does not allow Super Mode to discard an uncertain in-progress native update", async () => {
    setSuperMode(true)
    setGlassesDisconnected()
    useGlassesStore.getState().setOtaStatus({
      sessionId: "s1",
      totalSteps: 1,
      currentStep: 1,
      stepType: "apk",
      phase: "download",
      stepPercent: 10,
      overallPercent: 10,
      status: "in_progress",
    })
    const replaceSpy = jest.spyOn(useNavigationStore.getState(), "replace")
    const {queryByText} = await renderProgress()
    expect(queryByText("Skip (super)")).toBeNull()
    expect(replaceSpy).not.toHaveBeenCalled()
    replaceSpy.mockRestore()
  })

  it("hides Skip (super) when disconnected without super mode", async () => {
    setGlassesDisconnected()
    useGlassesStore.getState().setOtaStatus({
      sessionId: "s1",
      totalSteps: 1,
      currentStep: 1,
      stepType: "apk",
      phase: "download",
      stepPercent: 10,
      overallPercent: 10,
      status: "in_progress",
    })
    const {queryByText} = await renderProgress()
    expect(queryByText("Skip (super)")).toBeNull()
  })

  it("does NOT override complete state on disconnect", async () => {
    const nextBuild = MINIMUM_OTA_STATUS_BUILD + 1
    useGlassesStore.getState().setGlassesInfo(connectedGlassesInfo({buildNumber: sb(MINIMUM_OTA_STATUS_BUILD)}))
    useGlassesStore.getState().setOtaUpdateAvailable({
      available: true,
      versionCode: nextBuild,
      versionName: `${nextBuild}.0`,
      updates: ["apk"],
      totalSize: 0,
    })
    const {getByText, rerender} = await renderProgress()

    act(() => {
      useGlassesStore.getState().setOtaStatus({
        sessionId: "s1",
        totalSteps: 1,
        currentStep: 1,
        stepType: "apk",
        phase: "install",
        stepPercent: 100,
        overallPercent: 100,
        status: "complete",
      })
    })

    act(() => {
      useGlassesStore.getState().setGlassesInfo(connectedGlassesInfo({buildNumber: sb(nextBuild)}))
    })

    expect(getByText("Update complete!")).toBeDefined()

    act(() => {
      setGlassesDisconnected()
    })

    rerender(<OtaProgressScreen />)
    expect(getByText("Update complete!")).toBeDefined()
  })

  it("does NOT override failed state on disconnect", async () => {
    setGlassesConnected()
    const {getByText, rerender} = await renderProgress()

    act(() => {
      useGlassesStore.getState().setOtaStatus({
        sessionId: "s1",
        totalSteps: 1,
        currentStep: 1,
        stepType: "apk",
        phase: "download",
        stepPercent: 0,
        overallPercent: 0,
        status: "failed",
        error: "download_failed",
      })
    })

    expect(getByText("Update Failed")).toBeDefined()

    act(() => {
      setGlassesDisconnected()
    })

    rerender(<OtaProgressScreen />)
    expect(getByText("Update Failed")).toBeDefined()
  })
})

describe("progress.tsx watchdog timers", () => {
  it("fails after max serialized native ota_start failures", async () => {
    setGlassesConnected()
    BluetoothSdk.startOtaUpdate.mockRejectedValue(new Error("native timeout"))
    const {getByText} = await renderProgress()

    await act(async () => {
      await jest.advanceTimersByTimeAsync(16_000)
    })

    expect(getByText("Update Failed")).toBeDefined()
    expect(getByText(OtaProgressMessages.sendOtaStartFailed)).toBeDefined()
    expect(BluetoothSdk.startOtaUpdate).toHaveBeenCalledTimes(3)
  })

  it("does not fail or duplicate ota_start while the native request is pending", async () => {
    setGlassesConnected()
    let resolveStart!: (value: undefined) => void
    BluetoothSdk.startOtaUpdate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve
        }),
    )
    const {queryByText} = await renderProgress()

    await act(async () => {
      await jest.advanceTimersByTimeAsync(16_000)
    })

    expect(queryByText("Update Failed")).toBeNull()
    expect(BluetoothSdk.startOtaUpdate).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveStart(undefined)
      await Promise.resolve()
    })
  })

  it("fails stuck-at-zero after DOWNLOAD_STUCK_TIMEOUT_MS in starting", async () => {
    setGlassesConnected()
    const {getByText} = await renderProgress()

    act(() => {
      GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    })
    await act(async () => {
      await jest.advanceTimersByTimeAsync(70_000 + 1)
    })

    expect(getByText("Update Failed")).toBeDefined()
    expect(getByText(OtaProgressMessages.stalledOrStuck)).toBeDefined()
  })

  it("retains BES restart guidance after a progress stall until authoritative status allows exit", async () => {
    setGlassesConnected()
    const {getByText, queryByText} = await renderProgress()

    act(() => {
      useGlassesStore.getState().setOtaStatus({
        sessionId: "s1",
        totalSteps: 1,
        currentStep: 1,
        stepType: "bes",
        phase: "install",
        stepPercent: 10,
        overallPercent: 10,
        status: "in_progress",
      })
    })

    await act(async () => {
      await jest.advanceTimersByTimeAsync(120_000 + 1)
    })

    expect(getByText("Update Failed")).toBeDefined()
    expect(getByText(BES_INSTALL_RESTART_MESSAGE)).toBeDefined()
    expect(queryByText("Done")).toBeNull()
    expect(queryByText("Retry")).toBeNull()

    // The phone's watchdog cannot release ownership. A fresh terminal status
    // from the glasses restores the established safe Done action.
    act(() => {
      useGlassesStore.getState().setOtaStatus({
        sessionId: "s1",
        totalSteps: 1,
        currentStep: 1,
        stepType: "bes",
        phase: "install",
        stepPercent: 10,
        overallPercent: 10,
        status: "failed",
        error: "install_failed",
      })
    })
    expect(getByText(BES_INSTALL_RESTART_MESSAGE)).toBeDefined()
    expect(getByText("Done")).toBeDefined()
    expect(queryByText("Retry")).toBeNull()
    expect(BluetoothSdk.startOtaUpdate).toHaveBeenCalledTimes(1)
  })

  it("queries the resumed session without starting a second OTA after a multi-step APK reconnect", async () => {
    useGlassesStore.getState().setGlassesInfo(connectedGlassesInfo({buildNumber: sb(MINIMUM_OTA_STATUS_BUILD + 3)}))
    await renderProgress()
    BluetoothSdk.startOtaUpdate.mockClear()

    act(() => {
      useGlassesStore.getState().setOtaStatus({
        sessionId: "s1",
        totalSteps: 2,
        currentStep: 1,
        stepType: "apk",
        phase: "install",
        stepPercent: 100,
        overallPercent: 50,
        status: "step_complete",
      })
    })
    BluetoothSdk.queryOtaStatus.mockClear()
    BluetoothSdk.startOtaUpdate.mockClear()

    act(() => {
      setGlassesDisconnected()
    })
    act(() => {
      setGlassesConnected()
    })

    expect(BluetoothSdk.queryOtaStatus).toHaveBeenCalledTimes(1)
    expect(BluetoothSdk.startOtaUpdate).not.toHaveBeenCalled()

    await act(async () => {
      await jest.advanceTimersByTimeAsync(6000)
    })

    expect(BluetoothSdk.startOtaUpdate).not.toHaveBeenCalled()
  })

  it("pings periodically while updating", async () => {
    setGlassesConnected()
    await renderProgress()
    BluetoothSdk.ping.mockClear()

    act(() => {
      useGlassesStore.getState().setOtaStatus({
        sessionId: "s1",
        totalSteps: 1,
        currentStep: 1,
        stepType: "bes",
        phase: "install",
        stepPercent: 5,
        overallPercent: 5,
        status: "in_progress",
      })
    })

    expect(BluetoothSdk.ping).toHaveBeenCalled()
    BluetoothSdk.ping.mockClear()
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10_000)
    })
    expect(BluetoothSdk.ping).toHaveBeenCalled()
  })
})

describe("progress.tsx progress heartbeat", () => {
  it("does NOT fail global timeout before PROGRESS_TIMEOUT when progress keeps updating", async () => {
    setGlassesConnected()
    const {queryByText} = await renderProgress()

    act(() => {
      useGlassesStore.getState().setOtaStatus({
        sessionId: "s1",
        totalSteps: 1,
        currentStep: 1,
        stepType: "bes",
        phase: "install",
        stepPercent: 1,
        overallPercent: 1,
        status: "in_progress",
      })
    })

    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000)
    })
    act(() => {
      useGlassesStore.getState().setOtaStatus({
        sessionId: "s1",
        totalSteps: 1,
        currentStep: 1,
        stepType: "bes",
        phase: "install",
        stepPercent: 2,
        overallPercent: 2,
        status: "in_progress",
      })
    })
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000)
    })

    expect(queryByText(OtaProgressMessages.stalledOrStuck)).toBeNull()
  })
})

describe("progress.tsx reconnect", () => {
  it("starts OTA on mount when connected (no session yet)", async () => {
    setGlassesConnected()
    await renderProgress()
    expect(BluetoothSdk.startOtaUpdate).toHaveBeenCalled()
  })

  it("retry button starts OTA after the previous native request ended", async () => {
    setGlassesConnected()
    const {getByTestId} = await renderProgress()

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    BluetoothSdk.startOtaUpdate.mockClear()

    act(() => {
      useGlassesStore.getState().setOtaStatus({
        sessionId: "s1",
        totalSteps: 1,
        currentStep: 1,
        stepType: "apk",
        phase: "download",
        stepPercent: 0,
        overallPercent: 0,
        status: "failed",
        error: "download_failed",
      })
    })

    await act(async () => {
      fireEvent.press(getByTestId("button-Retry"))
    })
    expect(BluetoothSdk.startOtaUpdate).toHaveBeenCalledTimes(1)
  })
})

describe("progress.tsx overlay suppression", () => {
  it("sets suppressOverlay on mount", async () => {
    setGlassesConnected()
    expect(useConnectionOverlayConfig.getState().suppressOverlay).toBe(false)
    await renderProgress()
    expect(useConnectionOverlayConfig.getState().suppressOverlay).toBe(true)
  })

  it("clears config on unmount", async () => {
    setGlassesConnected()
    const {unmount} = await renderProgress()
    expect(useConnectionOverlayConfig.getState().suppressOverlay).toBe(true)
    unmount()
    expect(useConnectionOverlayConfig.getState().suppressOverlay).toBe(false)
  })
})
