import {act, fireEvent, render as renderNow, renderHook as renderHookNow, waitFor} from "@testing-library/react-native"

import {MentraLiveOtaFlow, useMentraLiveOta} from "@mentra/engine/ota"

import {
  getMentraLiveOtaSession,
  resolveMentraLiveOtaProvider,
  releaseMentraLiveOtaSession,
} from "../../../../modules/engine/src/devices/mentra-live/sessionRegistry"
const beginOtaAutoChain = (
  ...args: Parameters<NonNullable<ReturnType<typeof getMentraLiveOtaSession>>["chain"]["beginOtaAutoChain"]>
) => getMentraLiveOtaSession()!.chain.beginOtaAutoChain(...args)
const isOtaAutoChainActive = () => getMentraLiveOtaSession()!.chain.isOtaAutoChainActive()
const stopOtaAutoChain = () => getMentraLiveOtaSession()!.chain.stopOtaAutoChain()
import {liveOtaPorts as ota} from "@/../modules/engine/src/devices/mentra-live/ports"
import {useGlassesStore} from "@/../modules/engine/src/stores/glasses"
import {bluetoothSdkMock, resetBluetoothSdkMock} from "@/test-utils/mockBluetoothSdk"

async function render(element: React.ReactElement) {
  const view = renderNow(element)
  await act(async () => {})
  return view
}
async function renderHook<T>(hook: () => T) {
  const view = renderHookNow(hook)
  await act(async () => {})
  return view
}

describe("MentraLiveOtaFlow", () => {
  beforeEach(async () => {
    useGlassesStore.getState().reset()
    bluetoothSdkMock.getDefaultDevice.mockResolvedValue({id: "live-test", model: "Mentra Live", name: "Live"} as never)
    await resolveMentraLiveOtaProvider()
  })

  afterEach(() => {
    stopOtaAutoChain()
    useGlassesStore.getState().setGlassesInfo({connection: {state: "disconnected"}})
    getMentraLiveOtaSession()!.check()
    releaseMentraLiveOtaSession()
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
    await render(<MentraLiveOtaFlow onFinished={onFinished} onOpenWifiSetup={jest.fn()} />)

    expect(onFinished).not.toHaveBeenCalled()
    await act(async () => {
      await Promise.resolve()
      finishInitialization()
    })

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
    const {getByTestId, getByText} = await render(
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

    await act(async () => {
      fireEvent.press(getByTestId("button-Update Now"))
    })

    expect(prepare).toHaveBeenCalledWith(result)
    expect(getByText("Starting update…")).toBeDefined()
  })

  it("keeps the approved flow finishing when an installed MTK patch is awaiting reboot", async () => {
    jest.useFakeTimers()
    resetBluetoothSdkMock()
    bluetoothSdkMock.getDefaultDevice.mockResolvedValue({id: "live-test", model: "Mentra Live", name: "Live"} as never)
    const legacyVersions = {
      appVersion: "37.0",
      buildNumber: "37",
      androidVersion: "11",
      firmwareVersion: "",
      mtkFirmwareVersion: "MentraLive_20260418",
      besFirmwareVersion: "17.26.7.9",
      otaVersionUrl: "https://ota.example/legacy.json",
    }
    const modernVersions = {
      ...legacyVersions,
      appVersion: "39.0",
      buildNumber: "39",
      mtkFirmwareVersion: "MentraLive_20260709",
    }
    useGlassesStore.getState().setGlassesInfo({
      ...legacyVersions,
      connection: {state: "connected", fullyBooted: true},
      wifi: {state: "connected", ssid: "Test WiFi"},
    })
    useGlassesStore.getState().setMtkUpdatedThisSession(true)
    bluetoothSdkMock.requestVersionInfo.mockResolvedValueOnce(legacyVersions).mockResolvedValueOnce(modernVersions)
    jest.spyOn(global, "fetch").mockImplementation(
      async (url) =>
        ({
          ok: true,
          json: async () =>
            url === legacyVersions.otaVersionUrl
              ? {
                  apps: {"com.mentra.asg_client": {versionCode: 37, versionName: "37.0"}},
                  mtk_patches: [
                    {
                      start_firmware: legacyVersions.mtkFirmwareVersion,
                      end_firmware: modernVersions.mtkFirmwareVersion,
                      url: "https://ota.example/mtk.zip",
                    },
                  ],
                }
              : {
                  releaseVersion: "3.1.1",
                  apps: {"com.mentra.asg_client": {versionCode: 301010001, versionName: "3.1.1"}},
                  bes_firmware: {version: "26.9.4.1", url: "https://ota.example/bes.bin"},
                },
        } as Response),
    )
    beginOtaAutoChain("legacy-mtk", false, {fromVersion: "37.0", toVersion: "37.0", releaseVersion: null})
    const onFinished = jest.fn()
    const prepare = jest.spyOn(ota.installSession, "prepare").mockImplementation(() => "wifi")
    jest.spyOn(ota.installSession, "attach").mockImplementation(() => {})
    jest.spyOn(ota.installSession, "detach").mockImplementation(() => {})
    const {result, unmount} = await renderHook(() => useMentraLiveOta({initializeRuntime: false, onFinished}))

    await act(async () => {
      await jest.advanceTimersByTimeAsync(7_000)
    })
    expect(result.current.state).toMatchObject({screen: "finishing", completedUpdate: false, canFinish: false})
    expect(isOtaAutoChainActive()).toBe(true)
    expect(onFinished).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()

    // The real checker must now change manifests and the real hook must resume
    // the approved session automatically, without showing a completion screen.
    await act(async () => {
      useGlassesStore.getState().setMtkUpdatedThisSession(false)
      useGlassesStore.getState().setGlassesInfo(modernVersions)
      await jest.advanceTimersByTimeAsync(1_100)
    })
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({buildNumber: "39", updates: ["apk", "bes"]}))
    expect(result.current.state).toMatchObject({screen: "starting", completedUpdate: false})
    expect(isOtaAutoChainActive()).toBe(true)
    expect(onFinished).not.toHaveBeenCalled()
    unmount()
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
    const {getByTestId, getByText, queryByText} = await render(
      <MentraLiveOtaFlow initializeRuntime={false} onFinished={jest.fn()} onOpenWifiSetup={jest.fn()} />,
    )

    await act(async () => {
      await jest.advanceTimersByTimeAsync(1_100)
    })
    await act(async () => {
      fireEvent.press(getByTestId("button-Update Now"))
    })

    expect(prepare).not.toHaveBeenCalled()
    expect(getByText("Charge Mentra Live to Update")).toBeDefined()
    expect(getByText("Mentra Live is currently at 12%. Charge it to at least 25% before updating.")).toBeDefined()
    expect(getByText("This screen will update automatically as the battery charges.")).toBeDefined()

    act(() => useGlassesStore.getState().setBatteryInfo(24, true, -1, false))
    expect(getByText("Mentra Live is currently at 24%. Charge it to at least 25% before updating.")).toBeDefined()

    act(() => useGlassesStore.getState().setBatteryInfo(25, true, -1, false))
    await waitFor(() => expect(getByText("Mentra Live Update Available")).toBeDefined())
    expect(queryByText("Charge Mentra Live to Update")).toBeNull()

    await act(async () => {
      fireEvent.press(getByTestId("button-Update Now"))
    })
    expect(prepare).toHaveBeenCalledWith(result)
    expect(getByText("Starting update…")).toBeDefined()
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
    const {getByTestId, getByText} = await render(
      <MentraLiveOtaFlow initializeRuntime={false} onFinished={onFinished} onOpenWifiSetup={jest.fn()} />,
    )

    await act(async () => {
      await jest.advanceTimersByTimeAsync(1_100)
    })
    expect(getByText("Connect your Mentra Live to Wi-Fi to install the update.")).toBeDefined()

    await act(async () => {
      fireEvent.press(getByTestId("button-Later"))
    })
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
    const {getByText, rerender} = await render(
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
    expect(getByText("Up to Date")).toBeDefined()
  })

  it("reports that progress is inactive when the flow unmounts", async () => {
    useGlassesStore.getState().setGlassesInfo({
      connection: {state: "connected", fullyBooted: true},
    })
    const onFirmwareRestartingChange = jest.fn()
    const {unmount} = await render(
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

  it("presents a firmware reboot as active work with no completion action", async () => {
    useGlassesStore.getState().setGlassesInfo({
      connection: {state: "connected", fullyBooted: true},
    })
    const {getByText, queryByTestId} = await render(
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
