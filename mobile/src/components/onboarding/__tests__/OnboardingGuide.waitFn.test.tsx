import {act, fireEvent, render} from "@testing-library/react-native"

import {OnboardingGuide, OnboardingStep} from "@/components/onboarding/OnboardingGuide"
import {getBluetoothSdkListenerCount, resetBluetoothSdkMock} from "@/test-utils/mockBluetoothSdk"
import BluetoothSdk from "@mentra/bluetooth-sdk"

const mockFocusEffectPreventBack = jest.fn()

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
  focusEffectPreventBack: (callback: () => void) => mockFocusEffectPreventBack(callback),
}))

jest.mock("@/stores/navigation", () => ({
  useNavigationStore: {getState: () => ({clearHistoryAndGoHome: jest.fn()})},
}))

jest.mock("@/components/ignite", () => {
  const {Text: RNText, TouchableOpacity} = require("react-native")
  const React = require("react")
  return {
    Text: ({text, children}: any) => React.createElement(RNText, null, text ?? children),
    Button: ({text, tx, onPress}: any) =>
      React.createElement(TouchableOpacity, {onPress}, React.createElement(RNText, null, text ?? tx)),
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
    resetBluetoothSdkMock()
    mockFocusEffectPreventBack.mockClear()
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
    expect(getBluetoothSdkListenerCount("button_press")).toBeLessThanOrEqual(1)
  })

  it("renders structured image-step details and actions", () => {
    const handleAction = jest.fn()
    const {getByText} = render(
      <OnboardingGuide
        autoStart={true}
        requiresGlassesConnection={false}
        steps={[
          {
            type: "image",
            source: {uri: "step.png"},
            name: "MentraOS step",
            transition: false,
            title: "Start using a miniapp",
            details: [
              {
                title: "Tap to launch",
                description: "Tap any miniapp to have it launch instantly.",
              },
            ],
            action: {
              label: "Open MentraOS Legacy",
              onPress: handleAction,
            },
          },
        ]}
      />,
    )

    expect(getByText("Tap to launch")).toBeTruthy()
    expect(getByText("Tap any miniapp to have it launch instantly.")).toBeTruthy()
    fireEvent.press(getByText("Open MentraOS Legacy"))
    expect(handleAction).toHaveBeenCalledTimes(1)
  })

  it("advances from a transition welcome after the start gate", () => {
    const {getByText, queryByText} = render(
      <OnboardingGuide
        autoStart={false}
        startButtonText="Start onboarding"
        steps={[
          {
            type: "image",
            source: {uri: "welcome.png"},
            name: "Welcome",
            transition: true,
            duration: 500,
            title: "Welcome to Mentra",
          },
          {
            type: "image",
            source: {uri: "first.png"},
            name: "First",
            transition: false,
            title: "First lesson",
          },
        ]}
      />,
    )

    fireEvent.press(getByText("Start onboarding"))
    act(() => {
      jest.advanceTimersByTime(500)
    })

    expect(getByText("First lesson")).toBeTruthy()
    expect(queryByText("Welcome to Mentra")).toBeNull()
  })

  it("navigates back to a peer first step without reopening the start gate", () => {
    const {getByText, queryByText} = render(
      <OnboardingGuide
        autoStart={false}
        preventBack={true}
        startButtonText="Start onboarding"
        steps={[
          {
            type: "image",
            source: {uri: "first.png"},
            name: "First",
            transition: false,
            title: "First step",
          },
          {
            type: "image",
            source: {uri: "second.png"},
            name: "Second",
            transition: false,
            title: "Second step",
          },
        ]}
      />,
    )

    fireEvent.press(getByText("Start onboarding"))
    fireEvent.press(getByText("common:continue"))
    expect(getByText("Second step")).toBeTruthy()

    const backHandler = mockFocusEffectPreventBack.mock.calls.at(-1)?.[0]
    act(() => backHandler())

    expect(getByText("First step")).toBeTruthy()
    expect(queryByText("Start onboarding")).toBeNull()
  })
})
