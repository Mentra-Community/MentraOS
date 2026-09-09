import React from "react"
import {render, act, fireEvent, waitFor} from "@testing-library/react-native"

import {useGlassesStore} from "../../../../modules/engine/src/stores/glasses"
import {useNavigationStore} from "@/stores/navigation"

import {useConnectionOverlayConfig} from "@/contexts/ConnectionOverlayContext"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"

import OtaProgressScreen from "@/app/ota/progress"
import {BES_RESTART_TIMEOUT_MS, MINIMUM_OTA_STATUS_BUILD, OtaProgressMessages} from "@mentra/engine"
import {BES_INSTALL_RESTART_MESSAGE} from "@/utils/otaErrorMapping"
import {beginOtaAutoChain, isOtaAutoChainActive, stopOtaAutoChain} from "@/services/otaAutoChain"

const mockReplace = jest.fn()
const AUTO_CHAIN_RELEASE_RANGE = {fromVersion: "3.0.0", toVersion: "3.1.0-dev.1"}

// super_mode is controlled through the REAL settings store — the screen's
// useSetting comes from the global @mentra/engine mock, which passes the real
// store-backed hook through.
import {useSettingsStore} from "../../../../modules/engine/src/stores/settings"
const setSuperMode = (enabled: boolean) => useSettingsStore.getState().setSetting("super_mode", enabled, false)

jest.mock("@/contexts/NavigationHistoryContext", () => ({
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

beforeEach(() => {
  jest.useFakeTimers()
  setSuperMode(false)
  useGlassesStore.getState().reset()
  useConnectionOverlayConfig.getState().clearConfig()
  mockReplace.mockClear()
  BluetoothSdk.queryOtaStatus.mockClear()
  BluetoothSdk.startOtaUpdate.mockReset().mockResolvedValue(undefined)
  stopOtaAutoChain()
})

afterEach(() => {
  stopOtaAutoChain()
  jest.useRealTimers()
})

describe("progress.tsx display states", () => {
  it("starts in starting state", () => {
    setGlassesConnected()
    const {getByText} = render(<OtaProgressScreen />)
    expect(getByText("Starting update...")).toBeDefined()
  })

  it("transitions to updating on in_progress ota_status", () => {
    setGlassesConnected()
    const {getByText} = render(<OtaProgressScreen />)

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

    expect(getByText("Downloading...")).toBeDefined()
    expect(getByText("25%")).toBeDefined()
  })

  it("clamps displayed percent to 100 when overallPercent exceeds 100", () => {
    setGlassesConnected()
    const {getByText} = render(<OtaProgressScreen />)

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

  it("transitions to complete on complete ota_status even when a target build is known in store", () => {
    const nextBuild = MINIMUM_OTA_STATUS_BUILD + 1
    useGlassesStore.getState().setGlassesInfo(connectedGlassesInfo({buildNumber: sb(MINIMUM_OTA_STATUS_BUILD)}))
    useGlassesStore.getState().setOtaUpdateAvailable({
      available: true,
      versionCode: nextBuild,
      versionName: `${nextBuild}.0`,
      updates: ["apk"],
      totalSize: 0,
    })
    const {getByText} = render(<OtaProgressScreen />)

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

  it("transitions to complete on complete ota_status when no target build is set", () => {
    setGlassesConnected()
    const {getByText} = render(<OtaProgressScreen />)

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
    beginOtaAutoChain("initial-offer", false, AUTO_CHAIN_RELEASE_RANGE)
    const replaceSpy = jest.spyOn(useNavigationStore.getState(), "replace")
    try {
      const {getByText, queryByText} = render(<OtaProgressScreen />)

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

      expect(getByText("ota:finishingUpdate")).toBeDefined()
      expect(queryByText("Update complete!")).toBeNull()
      expect(replaceSpy).not.toHaveBeenCalledWith("/ota/check-for-updates")
      await act(async () => {
        await jest.advanceTimersByTimeAsync(750)
      })
      expect(getByText("ota:finishingUpdate")).toBeDefined()
      expect(useConnectionOverlayConfig.getState().suppressOverlay).toBe(false)
      expect(replaceSpy).not.toHaveBeenCalledWith("/ota/check-for-updates")
    } finally {
      replaceSpy.mockRestore()
    }
  })

  it("waits for a rebooting chained pass to reconnect before checking again", async () => {
    setGlassesDisconnected()
    beginOtaAutoChain("initial-offer", false, AUTO_CHAIN_RELEASE_RANGE)
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
      const {getByText} = render(<OtaProgressScreen />)

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
      expect(getByText("ota:finishingUpdate")).toBeDefined()
      expect(replaceSpy).not.toHaveBeenCalledWith("/ota/check-for-updates")
    } finally {
      replaceSpy.mockRestore()
    }
  })

  it("reschedules chained navigation when a reboot starts during the success delay", async () => {
    setGlassesConnected()
    beginOtaAutoChain("initial-offer", false, AUTO_CHAIN_RELEASE_RANGE)
    const replaceSpy = jest.spyOn(useNavigationStore.getState(), "replace")
    try {
      const {getByText} = render(<OtaProgressScreen />)
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
      expect(getByText("ota:finishingUpdate")).toBeDefined()
      expect(replaceSpy).not.toHaveBeenCalledWith("/ota/check-for-updates")
    } finally {
      replaceSpy.mockRestore()
    }
  })

  it("keeps a chained BES reboot non-actionable until the glasses reconnect", async () => {
    setGlassesConnected()
    beginOtaAutoChain("initial-offer", false, AUTO_CHAIN_RELEASE_RANGE)
    const {getByText, queryByTestId} = render(<OtaProgressScreen />)

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

    expect(getByText("ota:restartingGlasses")).toBeDefined()
    expect(getByText("ota:restartingGlassesMessage")).toBeDefined()
    expect(getByText("ota:restartingGlassesAutomatic")).toBeDefined()
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

  it("transitions to failed on failed ota_status with error", () => {
    setGlassesConnected()
    const {getByText} = render(<OtaProgressScreen />)

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
    expect(getByText("Glasses WiFi has no internet connection")).toBeDefined()
    expect(getByText("Retry")).toBeDefined()
  })

  it("stops automatic chaining when leaving a failed pass to change WiFi", () => {
    setGlassesConnected()
    beginOtaAutoChain("initial-offer", false, AUTO_CHAIN_RELEASE_RANGE)
    const pushSpy = jest.spyOn(useNavigationStore.getState(), "push")
    try {
      const {getByText} = render(<OtaProgressScreen />)

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

      fireEvent.press(getByText("Change WiFi"))

      expect(isOtaAutoChainActive()).toBe(false)
      expect(useConnectionOverlayConfig.getState().suppressOverlay).toBe(false)
      expect(pushSpy).toHaveBeenCalledWith("/wifi/scan")
    } finally {
      pushSpy.mockRestore()
    }
  })

  it("restores overlay suppression when retrying after WiFi setup", () => {
    setGlassesConnected()
    const {getByText} = render(<OtaProgressScreen />)

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

    fireEvent.press(getByText("Change WiFi"))
    expect(useConnectionOverlayConfig.getState().suppressOverlay).toBe(false)

    fireEvent.press(getByText("Retry"))
    expect(useConnectionOverlayConfig.getState().suppressOverlay).toBe(true)
  })

  it("requires a glasses restart for the existing generic BES install failure", () => {
    setGlassesConnected()
    const {getByText, queryByText} = render(<OtaProgressScreen />)

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

  it("shows disconnected state when not connected and not terminal", () => {
    setGlassesDisconnected()
    const {getByText} = render(<OtaProgressScreen />)
    expect(getByText("Glasses disconnected")).toBeDefined()
  })

  it("shows Skip (super) when disconnected in super mode", async () => {
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
    const {getByText, getByTestId} = render(<OtaProgressScreen />)
    expect(getByText("Skip (super)")).toBeDefined()
    fireEvent.press(getByTestId("button-Skip (super)"))
    await waitFor(() => expect(replaceSpy).toHaveBeenCalled())
    replaceSpy.mockRestore()
  })

  it("hides Skip (super) when disconnected without super mode", () => {
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
    const {queryByText} = render(<OtaProgressScreen />)
    expect(queryByText("Skip (super)")).toBeNull()
  })

  it("does NOT override complete state on disconnect", () => {
    const nextBuild = MINIMUM_OTA_STATUS_BUILD + 1
    useGlassesStore.getState().setGlassesInfo(connectedGlassesInfo({buildNumber: sb(MINIMUM_OTA_STATUS_BUILD)}))
    useGlassesStore.getState().setOtaUpdateAvailable({
      available: true,
      versionCode: nextBuild,
      versionName: `${nextBuild}.0`,
      updates: ["apk"],
      totalSize: 0,
    })
    const {getByText, rerender} = render(<OtaProgressScreen />)

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

  it("does NOT override failed state on disconnect", () => {
    setGlassesConnected()
    const {getByText, rerender} = render(<OtaProgressScreen />)

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
    const {getByText} = render(<OtaProgressScreen />)

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
    const {queryByText} = render(<OtaProgressScreen />)

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
    const {getByText} = render(<OtaProgressScreen />)

    act(() => {
      GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    })
    await act(async () => {
      await jest.advanceTimersByTimeAsync(70_000 + 1)
    })

    expect(getByText("Update Failed")).toBeDefined()
    expect(getByText(OtaProgressMessages.stalledOrStuck)).toBeDefined()
  })

  it("fails progress stall after PROGRESS_TIMEOUT_MS with frozen ota_status", async () => {
    setGlassesConnected()
    const {getByText, queryByText} = render(<OtaProgressScreen />)

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
    expect(getByText("Done")).toBeDefined()
    expect(queryByText("Retry")).toBeNull()
  })

  it("queries the resumed session without starting a second OTA after a multi-step APK reconnect", async () => {
    useGlassesStore.getState().setGlassesInfo(connectedGlassesInfo({buildNumber: sb(MINIMUM_OTA_STATUS_BUILD + 3)}))
    render(<OtaProgressScreen />)
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
    render(<OtaProgressScreen />)
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
    const {queryByText} = render(<OtaProgressScreen />)

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
  it("starts OTA on mount when connected (no session yet)", () => {
    setGlassesConnected()
    render(<OtaProgressScreen />)
    expect(BluetoothSdk.startOtaUpdate).toHaveBeenCalled()
  })

  it("retry button starts OTA after the previous native request ended", async () => {
    setGlassesConnected()
    const {getByTestId} = render(<OtaProgressScreen />)

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

    fireEvent.press(getByTestId("button-Retry"))
    expect(BluetoothSdk.startOtaUpdate).toHaveBeenCalledTimes(1)
  })
})

describe("progress.tsx overlay suppression", () => {
  it("sets suppressOverlay on mount", () => {
    setGlassesConnected()
    expect(useConnectionOverlayConfig.getState().suppressOverlay).toBe(false)
    render(<OtaProgressScreen />)
    expect(useConnectionOverlayConfig.getState().suppressOverlay).toBe(true)
  })

  it("clears config on unmount", () => {
    setGlassesConnected()
    const {unmount} = render(<OtaProgressScreen />)
    expect(useConnectionOverlayConfig.getState().suppressOverlay).toBe(true)
    unmount()
    expect(useConnectionOverlayConfig.getState().suppressOverlay).toBe(false)
  })
})
