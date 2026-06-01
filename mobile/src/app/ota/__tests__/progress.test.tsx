import React from "react"
import {render, act, fireEvent} from "@testing-library/react-native"

import {useGlassesStore} from "@/stores/glasses"

import {useConnectionOverlayConfig} from "@/contexts/ConnectionOverlayContext"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"

import OtaProgressScreen from "@/app/ota/progress"
import {MINIMUM_OTA_STATUS_BUILD, OtaProgressMessages} from "@/app/ota/otaProgressTimeouts"

const mockReplace = jest.fn()

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

jest.mock("@/utils/GlobalEventEmitter", () => {
  const {EventEmitter} = require("events")
  return {__esModule: true, default: new EventEmitter()}
})

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
  useGlassesStore.getState().reset()
  useConnectionOverlayConfig.getState().clearConfig()
  mockReplace.mockClear()
  BluetoothSdk.sendOtaQueryStatus.mockClear()
  BluetoothSdk.sendOtaStart.mockClear()
})

afterEach(() => {
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

  it("shows disconnected state when not connected and not terminal", () => {
    setGlassesDisconnected()
    const {getByText} = render(<OtaProgressScreen />)
    expect(getByText("Glasses disconnected")).toBeDefined()
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
  it("fails with no-ack message after max ota_start retries while still starting", async () => {
    setGlassesConnected()
    const {getByText} = render(<OtaProgressScreen />)

    await act(async () => {
      await jest.advanceTimersByTimeAsync(16_000)
    })

    expect(getByText("Update Failed")).toBeDefined()
    expect(getByText(OtaProgressMessages.noAckResponse)).toBeDefined()
  })

  it("does not fail no-ack when ota_start_ack is received", async () => {
    setGlassesConnected()
    const {queryByText} = render(<OtaProgressScreen />)

    await act(async () => {
      await jest.advanceTimersByTimeAsync(4000)
    })
    act(() => {
      GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    })
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5100)
    })

    expect(queryByText(OtaProgressMessages.noAckResponse)).toBeNull()
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
    const {getByText} = render(<OtaProgressScreen />)

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
    expect(getByText(OtaProgressMessages.stalledOrStuck)).toBeDefined()
  })

  it("delays sendOtaStart after reconnect when multi-step APK completed", async () => {
    useGlassesStore.getState().setGlassesInfo(connectedGlassesInfo({buildNumber: sb(MINIMUM_OTA_STATUS_BUILD + 3)}))
    render(<OtaProgressScreen />)
    BluetoothSdk.sendOtaStart.mockClear()

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

    act(() => {
      setGlassesDisconnected()
    })
    act(() => {
      setGlassesConnected()
    })

    expect(BluetoothSdk.sendOtaStart).not.toHaveBeenCalled()

    await act(async () => {
      await jest.advanceTimersByTimeAsync(6000)
    })

    expect(BluetoothSdk.sendOtaStart).toHaveBeenCalled()
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
  it("sends sendOtaStart on mount when connected (no session yet)", () => {
    setGlassesConnected()
    render(<OtaProgressScreen />)
    expect(BluetoothSdk.sendOtaStart).toHaveBeenCalled()
  })

  it("retry button calls sendOtaStart", () => {
    setGlassesConnected()
    const {getByTestId} = render(<OtaProgressScreen />)

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
    expect(BluetoothSdk.sendOtaStart).toHaveBeenCalled()
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
