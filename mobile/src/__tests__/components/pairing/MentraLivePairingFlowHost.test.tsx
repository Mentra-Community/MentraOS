import {engine} from "@mentra/engine"
import type {UseMentraLivePairingOptions} from "@mentra/engine/pairing"
import {render, waitFor} from "@testing-library/react-native"
import {Platform} from "react-native"

import {MentraLivePairingFlowHost} from "@/components/pairing/MentraLivePairingFlowHost"
import {usePushPrevious, usePushUnder} from "@/contexts/NavigationHistoryContext"
import {useNavigationStore} from "@/stores/navigation"

let options: UseMentraLivePairingOptions
jest.mock("@mentra/engine/pairing", () => ({
  useMentraLivePairing: (next: UseMentraLivePairingOptions) => {
    options = next
    return {state: {page: "scan"}, back: jest.fn()}
  },
  MentraLivePairingPages: () => null,
}))
jest.mock("expo-video", () => ({useVideoPlayer: jest.fn(), VideoView: () => null}))
jest.mock("@/contexts/NavigationHistoryContext", () => ({
  focusEffectPreventBack: jest.fn(),
  usePushPrevious: jest.fn(),
  usePushUnder: jest.fn(),
}))
jest.mock("@/stores/navigation", () => ({useNavigationStore: {getState: jest.fn()}}))
jest.mock("@/components/glasses/GlassesTroubleshootingModal", () => () => null)
jest.mock("@/utils/getGlassesImage", () => ({getGlassesOpenImage: jest.fn(() => 1)}))

const originalPlatformOS = Platform.OS
const setPlatformOS = (os: typeof Platform.OS) =>
  Object.defineProperty(Platform, "OS", {value: os, configurable: true, writable: true})

describe("Mentra Live pairing in the Mentra App", () => {
  const push = jest.fn()
  const goBack = jest.fn()
  const replaceAll = jest.fn()
  const clearHistoryAndGoHome = jest.fn()
  const pushUnder = jest.fn()
  const pushPrevious = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
    ;(useNavigationStore.getState as jest.Mock).mockReturnValue({push, goBack, replaceAll, clearHistoryAndGoHome})
    ;(usePushUnder as jest.Mock).mockReturnValue(pushUnder)
    ;(usePushPrevious as jest.Mock).mockReturnValue(pushPrevious)
  })

  afterEach(() => setPlatformOS(originalPlatformOS))

  it("continues to Pair Audio, then the update check, on an iPhone without Classic audio", async () => {
    setPlatformOS("ios")
    ;(engine.pairing.waitForBluetoothClassic as jest.Mock).mockResolvedValueOnce(false)
    render(<MentraLivePairingFlowHost initialPage="scan" />)
    options.onFinished()
    await waitFor(() => expect(push).toHaveBeenCalledWith("/pairing/btclassic"))
    expect(clearHistoryAndGoHome).toHaveBeenCalled()
    expect(pushUnder).toHaveBeenCalledWith("/ota/check-for-updates")
  })

  it("goes straight to the update check on Android", async () => {
    setPlatformOS("android")
    render(<MentraLivePairingFlowHost initialPage="scan" />)
    options.onFinished()
    await waitFor(() => expect(push).toHaveBeenCalledWith("/ota/check-for-updates"))
    expect(push).not.toHaveBeenCalledWith("/pairing/btclassic")
  })

  it("returns standalone Pair Audio to the step that opened it", () => {
    render(<MentraLivePairingFlowHost deviceName="MENTRA_LIVE_BLE_E511" initialPage="pair_audio" />)
    options.onFinished()
    expect(pushPrevious).toHaveBeenCalled()
  })

  it("leaves the scan back to the previous screen, and a failure or cancelled Pair Audio to Home", () => {
    render(<MentraLivePairingFlowHost initialPage="scan" />)
    options.onExit("scan")
    expect(goBack).toHaveBeenCalledTimes(1)
    options.onExit("failure")
    options.onExit("pair_audio")
    expect(clearHistoryAndGoHome).toHaveBeenCalledTimes(2)
  })

  it("sends a forgotten pairing after sign-out to sign-in", () => {
    render(<MentraLivePairingFlowHost deviceName="Mentra_Live_E511" initialPage="forget_ios_pairing" then="sign-in" />)
    options.onExit("forget_ios_pairing")
    expect(replaceAll).toHaveBeenCalledWith("/auth/start")
  })

  it("starts over from model selection after a failure", () => {
    render(<MentraLivePairingFlowHost initialPage="scan" />)
    options.onRetry!()
    expect(clearHistoryAndGoHome).toHaveBeenCalled()
    expect(push).toHaveBeenCalledWith("/pairing/select-glasses-model")
  })
})
