import {act, fireEvent, render, waitFor} from "@testing-library/react-native"

import {MentraLiveOtaFlow} from "@mentra/engine/ota"

import {stopOtaAutoChain} from "@/services/otaAutoChain"
import {ota} from "@/../modules/engine/src/facades/ota"
import {useGlassesStore} from "@/../modules/engine/src/stores/glasses"

describe("MentraLiveOtaFlow", () => {
  beforeEach(() => {
    useGlassesStore.getState().reset()
  })

  afterEach(() => {
    stopOtaAutoChain()
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
      appVersion: "3.1.0-dev.7",
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
      releaseVersion: "3.1.0-dev.8",
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
    expect(getByText("3.1.0-dev.7 → 3.1.0-dev.8")).toBeDefined()
    expect(
      getByText(
        "Your glasses may install more than one update and restart several times. Keep them nearby until finished.",
      ),
    ).toBeDefined()

    fireEvent.press(getByTestId("button-Update Now"))

    expect(prepare).toHaveBeenCalledWith(result)
    expect(getByText("Starting update...")).toBeDefined()
  })

  it("blocks an update below 25% and reacts to live battery changes", async () => {
    jest.useFakeTimers()
    useGlassesStore.getState().setGlassesInfo({
      connection: {state: "connected", fullyBooted: true},
      buildNumber: "37",
      hotspotOtaVersion: 1,
      wifi: {state: "disconnected"},
    })
    useGlassesStore.getState().setBatteryInfo(12, false, -1, false)
    const result = {
      hasCheckCompleted: true,
      updateAvailable: true,
      latestVersionInfo: null,
      updates: ["apk"],
      mtkPatch: null,
      besVersion: null,
      isApkDowngrade: false,
      manifestBody: "{}",
      releaseVersion: "3.1.0-dev.8",
      updateInfo: {isDowngrade: false, updates: [{type: "apk"}], versionName: "38"},
      isRequired: true,
      manifestUrl: "https://example.com/version.json",
      buildNumber: "37",
    }
    jest.spyOn(ota, "checkForUpdates").mockResolvedValue(result as never)
    const prepare = jest.spyOn(ota.installSession, "prepare").mockImplementation(() => "hotspot")
    const {getByTestId, getByText, queryByText} = render(
      <MentraLiveOtaFlow initializeRuntime={false} onFinished={jest.fn()} onOpenWifiSetup={jest.fn()} />,
    )

    await act(async () => {
      await jest.advanceTimersByTimeAsync(1_100)
    })
    fireEvent.press(getByTestId("button-Update Now"))

    expect(prepare).not.toHaveBeenCalled()
    expect(getByText("Charge Mentra Live to Update")).toBeDefined()
    expect(getByText("Mentra Live is currently at 12%. Charge it to at least 25% before updating.")).toBeDefined()
    expect(getByText("This screen will update automatically as the battery charges.")).toBeDefined()

    act(() => useGlassesStore.getState().setBatteryInfo(24, true, -1, false))
    expect(getByText("Mentra Live is currently at 24%. Charge it to at least 25% before updating.")).toBeDefined()

    act(() => useGlassesStore.getState().setBatteryInfo(25, true, -1, false))
    await waitFor(() => expect(getByText("Mentra Live Update Available")).toBeDefined())
    expect(queryByText("Charge Mentra Live to Update")).toBeNull()

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
      releaseVersion: null,
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
      releaseVersion: null,
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

  it("presents a firmware reboot as active work with no completion action", () => {
    useGlassesStore.getState().setGlassesInfo({
      connection: {state: "connected", fullyBooted: true},
    })
    const {getByText, queryByTestId} = render(
      <MentraLiveOtaFlow
        initialPage="progress"
        initializeRuntime={false}
        onFinished={jest.fn()}
        onOpenWifiSetup={jest.fn()}
      />,
    )

    act(() => {
      useGlassesStore.getState().setOtaStatus({
        sessionId: "session",
        totalSteps: 1,
        currentStep: 1,
        stepType: "bes",
        phase: "install",
        stepPercent: 100,
        overallPercent: 100,
        status: "step_complete",
      })
    })

    expect(getByText("Restarting Mentra Live…")).toBeDefined()
    expect(
      getByText(
        "The update is installed. Keep your glasses nearby and leave this screen open while they finish starting.",
      ),
    ).toBeDefined()
    expect(getByText("We'll continue automatically when they're ready.")).toBeDefined()
    expect(queryByTestId("button-Continue")).toBeNull()
  })
})
