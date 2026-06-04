import {render, act} from "@testing-library/react-native"

import {OnboardingGuide, OnboardingStep} from "@/components/onboarding/OnboardingGuide"
import {getCoreModuleListenerCount, resetCoreModuleMock} from "@/test-utils/mockCoreModule"
import BluetoothSdk from "@mentra/bluetooth-sdk"

// --- Heavy / native deps that OnboardingGuide pulls in ---

jest.mock("expo-video", () => {
  const player = {
    loop: false,
    audioMixingMode: "mixWithOthers",
    currentTime: 0,
    duration: 1,
    play: jest.fn(),
    pause: jest.fn(),
    replaceAsync: jest.fn(() => Promise.resolve()),
    addListener: jest.fn(() => ({remove: jest.fn()})),
  }
  return {
    __esModule: true,
    useVideoPlayer: () => player,
    VideoView: () => null,
  }
})

jest.mock("expo-image", () => ({
  __esModule: true,
  Image: () => null,
}))

jest.mock("@/components/brands/MentraLogoStandalone", () => ({
  MentraLogoStandalone: () => null,
}))

jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({
    theme: {colors: {primary: "#000", foreground: "#000", background: "#fff", muted_foreground: "#888"}},
  }),
}))

jest.mock("@/contexts/NavigationHistoryContext", () => ({
  focusEffectPreventBack: jest.fn(),
}))

jest.mock("@/stores/navigation", () => ({
  useNavigationStore: {getState: () => ({clearHistoryAndGoHome: jest.fn()})},
}))

jest.mock("@/stores/settings", () => ({
  SETTINGS: {super_mode: {key: "super_mode"}},
  useSetting: () => [false, jest.fn()],
}))

jest.mock("@/components/ignite", () => {
  const {Text: RNText, TouchableOpacity} = require("react-native")
  const React = require("react")
  return {
    Text: ({text, children}: any) => React.createElement(RNText, null, text ?? children),
    Button: ({text, onPress}: any) =>
      React.createElement(TouchableOpacity, {onPress}, React.createElement(RNText, null, text)),
    Header: () => null,
    Icon: () => null,
  }
})

// Build a Mentra-Live-style step list: a video step whose waitFn resolves on a
// short button_press, exactly like onboarding/live.tsx. Each call returns FRESH
// inline arrow functions, mirroring live.tsx rebuilding `steps` every render.
const buildSteps = (): OnboardingStep[] => [
  {
    type: "video",
    source: "photo.mp4",
    name: "Take a photo",
    playCount: -1,
    transition: false,
    fadeOut: false,
    title: "Take a photo",
    // Mirrors the abort-safe waitFn contract used by onboarding/live.tsx: the
    // button_press listener is removed both when it fires and when the step is
    // left (signal aborts), so it must never leak across re-renders.
    waitFn: (signal: AbortSignal): Promise<void> => {
      return new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve()
          return
        }
        const unsub = BluetoothSdk.addListener("button_press", (data: any) => {
          if (data?.pressType === "short") {
            unsub.remove()
            signal.removeEventListener("abort", onAbort)
            resolve()
          }
        })
        const onAbort = () => {
          unsub.remove()
        }
        signal.addEventListener("abort", onAbort)
      })
    },
  },
  {
    type: "video",
    source: "next.mp4",
    name: "Next",
    playCount: 1,
    transition: false,
    fadeOut: false,
  },
]

describe("OnboardingGuide waitFn lifecycle", () => {
  beforeEach(() => {
    resetCoreModuleMock()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  const renderGuide = () =>
    render(<OnboardingGuide steps={buildSteps()} autoStart={true} requiresGlassesConnection={false} />)

  it("does not leak button_press listeners across re-renders while on a waitFn step", () => {
    const {rerender} = renderGuide()

    // Drive to the waitFn step (index 1). The intro is a transition that
    // auto-advances; emit nothing, just let timers/effects settle.
    act(() => {
      jest.advanceTimersByTime(1000)
    })

    // Simulate the parent (live.tsx) re-rendering several times with a freshly
    // built `steps` array (new waitFn identities each render). This is exactly
    // what happens when any store/zustand selector updates during onboarding.
    for (let i = 0; i < 5; i++) {
      act(() => {
        rerender(<OnboardingGuide steps={buildSteps()} autoStart={true} requiresGlassesConnection={false} />)
      })
    }

    // BUG: each re-render registers a new button_press listener without removing
    // the previous one, so the count grows unbounded. There should be at most
    // one active listener for the current step.
    expect(getCoreModuleListenerCount("button_press")).toBeLessThanOrEqual(1)
  })
})
