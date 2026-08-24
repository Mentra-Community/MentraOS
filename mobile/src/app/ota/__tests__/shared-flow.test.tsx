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
