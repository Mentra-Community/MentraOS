import {act, fireEvent, render} from "@testing-library/react-native"
import type {ClientApp} from "@mentra/engine"
import {useRef} from "react"
import {InteractionManager} from "react-native"

import Compositor from "./Compositor"
import {useMiniappPresentationStore} from "@/stores/miniappLaunch"

let mockForegroundApp: ClientApp | null = null
const mockStop = jest.fn()
const mockMount = jest.fn()
jest.mock("@mentra/engine", () => ({
  SETTINGS: {ios_app_switcher_bottom_swipe: {key: "bottomSwipe"}},
  useSetting: () => [false],
  useForegroundApp: () => mockForegroundApp,
  engine: {
    miniapps: {
      list: () => (mockForegroundApp ? [mockForegroundApp] : []),
      clearForeground: () => {
        mockForegroundApp = null
      },
      stop: (...args: unknown[]) => mockStop(...args),
    },
  },
}))
jest.mock("@/components/miniapp/LocalMiniappView", () => {
  const {Pressable} = require("react-native")
  const {useEffect} = require("react")
  return ({onClose}: {onClose: () => void}) => {
    useEffect(() => {mockMount()}, [])
    return <Pressable testID="close-miniapp" onPress={onClose} />
  }
})
jest.mock("@/components/miniapp/OfflineAppHost", () => () => null)
jest.mock("@/components/miniapp/offlineHostedPackages", () => ({isOfflineHosted: () => false}))
jest.mock("@/effects/CapsuleMenu", () => ({captureScreenshot: jest.fn(), captureScreenshotForLater: jest.fn()}))
jest.mock("@/components/ignite/Screen", () => ({Screen: require("react-native").View}))
jest.mock("@/contexts/SaferAreaContext", () => ({useSaferAreaInsets: () => ({top: 0, bottom: 0})}))
jest.mock("@/stores/navigation", () => ({useNavigationStore: () => false}))
jest.mock("@/stores/appSwitcher", () => ({appSwitcherProgress: {value: 0}}))
jest.mock("@/utils/utils", () => ({hapticBuzz: jest.fn()}))
jest.mock("react-native-gesture-handler", () => ({
  Gesture: {
    Pan: () => {
      const builder = new Proxy({}, {get: () => () => builder})
      return builder
    },
  },
  GestureDetector: ({children}: {children: React.ReactNode}) => children,
}))

const reanimated = require("react-native-reanimated")
reanimated.useSharedValue = (initial: unknown) => useRef({value: initial}).current

beforeEach(() => {
  jest.useFakeTimers()
  jest.spyOn(InteractionManager, "runAfterInteractions").mockImplementation((callback: any) => {
    callback()
    return {cancel: jest.fn()} as any
  })
  useMiniappPresentationStore.setState({closingPackageName: null, revealedPackageName: null, replacedPackageName: null, replacementGeneration: 0})
  mockMount.mockClear()
  mockForegroundApp = {packageName: "one", name: "One", foregrounded: true, running: true} as ClientApp
  mockStop.mockReset()
})

afterEach(() => {
  jest.restoreAllMocks()
  jest.useRealTimers()
})

test("slow teardown cannot hide a relaunch or clear a later close animation", async () => {
  let finishFirstStop!: () => void
  mockStop.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finishFirstStop = resolve
    }),
  )
  mockStop.mockResolvedValue(undefined)
  const app = mockForegroundApp
  const view = render(<Compositor />)

  fireEvent.press(view.getByTestId("close-miniapp"))
  expect(useMiniappPresentationStore.getState().closingPackageName).toBe("one")
  expect(mockStop).not.toHaveBeenCalled()

  await act(async () => {
    jest.advanceTimersByTime(100)
  })
  expect(mockStop).toHaveBeenCalledWith("one")
  expect(useMiniappPresentationStore.getState().closingPackageName).toBeNull()

  // A relaunch is visible while the first shutdown remains pending.
  mockForegroundApp = app
  view.rerender(<Compositor />)
  fireEvent.press(view.getByTestId("close-miniapp"))
  expect(useMiniappPresentationStore.getState().closingPackageName).toBe("one")

  await act(async () => {
    finishFirstStop()
  })
  expect(useMiniappPresentationStore.getState().closingPackageName).toBe("one")
  await act(async () => {
    jest.advanceTimersByTime(100)
  })
  expect(mockStop).toHaveBeenCalledTimes(2)
  expect(useMiniappPresentationStore.getState().closingPackageName).toBeNull()
})

test("repacking the same version remounts its WebView; ordinary store refresh does not", () => {
  const view = render(<Compositor />)
  expect(mockMount).toHaveBeenCalledTimes(1)
  mockForegroundApp = {...mockForegroundApp!}
  view.rerender(<Compositor />)
  expect(mockMount).toHaveBeenCalledTimes(1)
  act(() => useMiniappPresentationStore.getState().replaceSurface("one"))
  expect(mockMount).toHaveBeenCalledTimes(2)
})
