import React from "react"
import {act, fireEvent, render, waitFor} from "@testing-library/react-native"

import {MentraLiveOtaFlow} from "@mentra/engine/ota"
import {ota} from "../../../../modules/engine/src/facades/ota"
import {useGlassesStore} from "../../../../modules/engine/src/stores/glasses"

describe("MentraLiveOtaFlow", () => {
  beforeEach(() => {
    useGlassesStore.getState().reset()
  })

  afterEach(() => {
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  it("does not leave the flow before OTA-only status hydration finishes", async () => {
    let finishInitialization: () => void = () => {}
    jest.spyOn(ota, "initialize").mockReturnValue(
      new Promise<void>((resolve) => {
        finishInitialization = resolve
      }),
    )
    const onFinished = jest.fn()
    render(<MentraLiveOtaFlow onFinished={onFinished} onOpenWifiSetup={jest.fn()} />)

    expect(onFinished).not.toHaveBeenCalled()
    finishInitialization()

    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1))
  })

  it("checks, offers, and enters progress without host navigation", async () => {
    jest.useFakeTimers()
    useGlassesStore.getState().setGlassesInfo({
      connection: {state: "connected", fullyBooted: true},
      buildNumber: "37",
      hotspotOtaVersion: 1,
      wifi: {state: "disconnected"},
    })
    const result = {
      hasCheckCompleted: true,
      updateAvailable: true,
      latestVersionInfo: null,
      updates: ["apk"],
      mtkPatch: null,
      besVersion: null,
      isApkDowngrade: false,
      manifestBody: "{}",
      updateInfo: {isDowngrade: false, updates: [{type: "apk"}], versionName: "38"},
      isRequired: true,
      manifestUrl: "https://example.com/version.json",
      buildNumber: "37",
    }
    jest.spyOn(ota, "checkForUpdates").mockResolvedValue(result as never)
    const prepare = jest.spyOn(ota.installSession, "prepare").mockImplementation(() => "hotspot")
    const {getByTestId, getByText} = render(
      <MentraLiveOtaFlow initializeRuntime={false} onFinished={jest.fn()} onOpenWifiSetup={jest.fn()} />,
    )

    await act(async () => {
      await jest.advanceTimersByTimeAsync(1_100)
    })
    expect(getByText("Mentra Live Update Available")).toBeDefined()

    fireEvent.press(getByTestId("button-Update Now"))

    expect(prepare).toHaveBeenCalledWith(result)
    expect(getByText("Starting update...")).toBeDefined()
  })

  it("lets the user dismiss an optional update when Wi-Fi setup is required", async () => {
    jest.useFakeTimers()
    useGlassesStore.getState().setGlassesInfo({
      connection: {state: "connected", fullyBooted: true},
      buildNumber: "36",
      hotspotOtaVersion: 0,
      wifi: {state: "disconnected"},
    })
    jest.spyOn(ota, "checkForUpdates").mockResolvedValue({
      hasCheckCompleted: true,
      updateAvailable: true,
      latestVersionInfo: null,
      updates: ["apk"],
      mtkPatch: null,
      besVersion: null,
      isApkDowngrade: false,
      manifestBody: "{}",
      updateInfo: {isDowngrade: false, updates: [{type: "apk"}], versionName: "37"},
      isRequired: false,
      manifestUrl: "https://example.com/version.json",
      buildNumber: "36",
    } as never)
    const onFinished = jest.fn()
    const {getByTestId, getByText} = render(
      <MentraLiveOtaFlow initializeRuntime={false} onFinished={onFinished} onOpenWifiSetup={jest.fn()} />,
    )

    await act(async () => {
      await jest.advanceTimersByTimeAsync(1_100)
    })
    expect(getByText("Connect your Mentra Live to WiFi to install the update.")).toBeDefined()

    fireEvent.press(getByTestId("button-Later"))
    expect(onFinished).toHaveBeenCalledTimes(1)
  })

  it("does not restart an active check when host callbacks change", async () => {
    jest.useFakeTimers()
    useGlassesStore.getState().setGlassesInfo({
      connection: {state: "connected", fullyBooted: true},
      buildNumber: "37",
      hotspotOtaVersion: 1,
      wifi: {state: "disconnected"},
    })
    let finishCheck: (result: unknown) => void = () => {}
    const check = jest.spyOn(ota, "checkForUpdates").mockReturnValue(
      new Promise((resolve) => {
        finishCheck = resolve
      }) as never,
    )
    const {getByText, rerender} = render(
      <MentraLiveOtaFlow initializeRuntime={false} onFinished={jest.fn()} onOpenWifiSetup={jest.fn()} />,
    )

    rerender(<MentraLiveOtaFlow initializeRuntime={false} onFinished={jest.fn()} onOpenWifiSetup={jest.fn()} />)
    rerender(<MentraLiveOtaFlow initializeRuntime={false} onFinished={jest.fn()} onOpenWifiSetup={jest.fn()} />)
    act(() => {
      useGlassesStore.getState().setGlassesInfo({buildNumber: "38"})
      useGlassesStore.getState().setGlassesInfo({mtkFirmwareVersion: "MentraLive_20260709"})
      useGlassesStore.getState().setGlassesInfo({besFirmwareVersion: "26.8.8.0"})
    })
    expect(check).toHaveBeenCalledTimes(1)

    finishCheck({
      hasCheckCompleted: true,
      updateAvailable: false,
      latestVersionInfo: null,
      updates: [],
      mtkPatch: null,
      besVersion: null,
      isApkDowngrade: false,
      manifestBody: "{}",
      updateInfo: null,
      isRequired: false,
      manifestUrl: "https://example.com/version.json",
      buildNumber: "37",
    })
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1_100)
    })

    expect(check).toHaveBeenCalledTimes(1)
    expect(getByText("Up To Date")).toBeDefined()
  })

  it("reports that progress is inactive when the flow unmounts", () => {
    useGlassesStore.getState().setGlassesInfo({
      connection: {state: "connected", fullyBooted: true},
    })
    const onFirmwareRestartingChange = jest.fn()
    const {unmount} = render(
      <MentraLiveOtaFlow
        initialPage="progress"
        initializeRuntime={false}
        onFinished={jest.fn()}
        onFirmwareRestartingChange={onFirmwareRestartingChange}
        onOpenWifiSetup={jest.fn()}
      />,
    )

    expect(onFirmwareRestartingChange).toHaveBeenLastCalledWith(false, true)
    unmount()
    expect(onFirmwareRestartingChange).toHaveBeenLastCalledWith(false, false)
  })
})
