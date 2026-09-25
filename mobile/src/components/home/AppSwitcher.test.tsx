import {act, configure, fireEvent, render, screen} from "@testing-library/react-native"
import type {ClientApp} from "@mentra/engine"
import type {SharedValue} from "react-native-reanimated"
import {useRef} from "react"
import {Dimensions} from "react-native"

import AppSwitcher from "./AppSwitcher"
import {useMiniappPresentationStore} from "@/stores/miniappLaunch"

let mockApps: ClientApp[] = []
const mockStop = jest.fn()
jest.mock("@mentra/engine", () => ({
  SETTINGS: {android_blur: {key: "android_blur"}},
  useSetting: () => [false],
  useActiveApps: () => mockApps,
  useForegroundApp: () => null,
  useSetForeground: () => jest.fn(),
  sortAppsByLastOpenTime: async (apps: ClientApp[]) => apps,
  engine: {miniapps: {stop: (...args: unknown[]) => mockStop(...args)}},
}))
jest.mock("@/i18n", () => ({translate: (key: string) => key}))
jest.mock("@/contexts/SaferAreaContext", () => ({useSaferAreaInsets: () => ({bottom: 0})}))
jest.mock("@/stores/navigation", () => ({useNavigationStore: {getState: () => ({push: jest.fn()})}}))
jest.mock("@/utils/utils", () => ({hapticBuzz: jest.fn()}))
jest.mock("@/utils/storage", () => ({storage: {load: () => ({is_ok: () => false}), save: jest.fn()}}))
jest.mock("@/components/home/AppIcon", () => () => null)
jest.mock("@/components/ui/GlassView", () => require("react-native").View)
jest.mock("expo-blur", () => ({BlurView: require("react-native").View}))
jest.mock("expo-image", () => ({Image: require("react-native").Image, useImage: () => null}))
jest.mock("@/components/ignite/", () => ({Text: require("react-native").Text}))
jest.mock("react-native-gesture-handler", () => {
  const gesture = () => {
    const builder = new Proxy({}, {get: () => () => builder})
    return builder
  }
  return {
    Gesture: {Pan: gesture, Tap: gesture, Exclusive: jest.fn()},
    GestureDetector: ({children}: {children: React.ReactNode}) => children,
  }
})

// Extend the shared animation mock for the switcher's presentation hooks.
const reanimated = require("react-native-reanimated")
reanimated.useAnimatedReaction = jest.fn()
reanimated.useAnimatedProps = (updater: () => unknown) => updater()
reanimated.useSharedValue = jest.fn((initial: number) => useRef({value: initial}).current)

const cardId = (pkg: string) => `runningApps.miniapp.${pkg}`
const tray = () => <AppSwitcher swipeProgress={{value: 1} as SharedValue<number>} blurTargetRef={{current: null}} />

beforeEach(() => {
  useMiniappPresentationStore.setState({closingPackageName: null})
  // The shared animation mock does not run the reaction that exposes the tray.
  configure({defaultIncludeHiddenElements: true})
  mockApps = ["one", "two"].map((packageName) => ({packageName, name: packageName} as ClientApp))
  mockStop.mockReset()
  reanimated.useAnimatedReaction.mockClear()
  reanimated.useSharedValue.mockClear()
})

function openingReaction() {
  return reanimated.useAnimatedReaction.mock.calls
    .filter(([prepare]: [() => unknown]) => typeof prepare() === "object")
    .at(-1)
}

test("each opening snaps the latest card into place even when the target index already matches", async () => {
  render(tray())
  await act(async () => {})
  const translateX = reanimated.useSharedValue.mock.results[0].value
  const targetIndex = reanimated.useSharedValue.mock.results[2].value
  const [prepare, react] = openingReaction()

  // Two cards: the last card is centered at offset zero. Simulate an
  // unfinished drag/spring while the saved target already points there.
  targetIndex.value = 0
  translateX.value = 90
  act(() => react({...prepare(), progress: 0.1}, {...prepare(), progress: 0}))
  expect(translateX.value).toBeCloseTo(0)
  expect(targetIndex.value).toBe(0)
})

test("centers a new app that finishes sorting after the tray has opened", async () => {
  const view = render(tray())
  await act(async () => {})
  const translateX = reanimated.useSharedValue.mock.results[0].value
  const targetIndex = reanimated.useSharedValue.mock.results[2].value
  const [previousPrepare] = openingReaction()
  const previous = previousPrepare()

  mockApps = [...mockApps, {packageName: "three", name: "three"} as ClientApp]
  view.rerender(tray())
  await act(async () => {})
  const [prepare, react] = openingReaction()
  act(() => react(prepare(), previous))
  expect(targetIndex.value).toBe(1)
  expect(translateX.value).toBe(-Dimensions.get("window").width * 0.67)

  // A normal store refresh must not interrupt horizontal browsing.
  translateX.value = 45
  act(() => react(prepare(), prepare()))
  expect(translateX.value).toBe(45)
})

test.each([
  {packages: ["one", "two"], centered: "two", dismissed: "one", expected: "two"},
  {packages: ["one", "two"], centered: "two", dismissed: "two", expected: "one"},
  {packages: ["one", "two", "three"], centered: "two", dismissed: "one", expected: "two"},
  {packages: ["one", "two", "three"], centered: "two", dismissed: "three", expected: "two"},
  {packages: ["one", "two", "three"], centered: "two", dismissed: "two", expected: "three"},
])(
  "keeps $expected centered when dismissing $dismissed from $packages",
  async ({packages, centered, dismissed, expected}) => {
    mockApps = packages.map((packageName) => ({packageName, name: packageName} as ClientApp))
    mockStop.mockResolvedValue(undefined)
    render(tray())
    await act(async () => {})
    const translateX = reanimated.useSharedValue.mock.results[0].value
    const offsetX = reanimated.useSharedValue.mock.results[1].value
    const targetIndex = reanimated.useSharedValue.mock.results[2].value
    const cardOrder = reanimated.useSharedValue.mock.results[5].value
    const [prepare, react] = openingReaction()
    const previous = prepare()
    act(() => react(previous, null))
    const cardWidth = Dimensions.get("window").width * 0.67
    targetIndex.value = packages.indexOf(centered) - 1
    translateX.value = -targetIndex.value * cardWidth

    fireEvent(screen.getByTestId(cardId(dismissed)), "accessibilityAction", {nativeEvent: {actionName: "dismiss"}})
    const [nextPrepare, nextReact] = openingReaction()
    act(() => nextReact(nextPrepare(), previous))

    expect(screen.queryByTestId(cardId(dismissed))).toBeNull()
    expect(cardOrder.value).toEqual(packages.filter((pkg) => pkg !== dismissed))
    // The card transform is centered when offset/cardWidth + its index = 1.
    expect(translateX.value / cardWidth + cardOrder.value.indexOf(expected)).toBeCloseTo(1)
    expect(targetIndex.value).toBe(cardOrder.value.indexOf(expected) - 1)
    expect(offsetX.value).toBe(translateX.value)
  },
)

test("X-button close hides the card while its runtime is still running", async () => {
  const view = render(tray())
  await act(async () => {})
  expect(screen.getByTestId(cardId("one"))).toBeTruthy()

  act(() => useMiniappPresentationStore.getState().setClosingPackageName("one"))
  expect(screen.queryByTestId(cardId("one"))).toBeNull()
  expect(screen.getByTestId(cardId("two"))).toBeTruthy()
  expect(mockStop).not.toHaveBeenCalled()

  // Clearing the close marker must not expose the old async-sorted snapshot.
  mockApps = mockApps.filter((app) => app.packageName !== "one")
  act(() => {
    useMiniappPresentationStore.getState().setClosingPackageName(null)
    view.rerender(tray())
  })
  expect(screen.queryByTestId(cardId("one"))).toBeNull()
  await act(async () => {})
})

test("removes a dismissed card before shutdown and keeps it hidden through stale store updates", async () => {
  mockStop.mockImplementation((pkg: string) => {
    expect(screen.queryByTestId(cardId(pkg))).toBeNull()
    return new Promise<void>(() => {})
  })
  const view = render(tray())
  await act(async () => {})

  fireEvent(screen.getByTestId(cardId("one")), "accessibilityAction", {nativeEvent: {actionName: "dismiss"}})
  expect(mockStop).toHaveBeenCalledWith("one")
  expect(screen.queryByTestId(cardId("one"))).toBeNull()

  // An unrelated update still reports the stopping miniapp as running.
  mockApps = [...mockApps]
  view.rerender(tray())
  await act(async () => {})
  expect(screen.queryByTestId(cardId("one"))).toBeNull()
  expect(mockStop).toHaveBeenCalledTimes(1)

  fireEvent(screen.getByTestId(cardId("two")), "accessibilityAction", {nativeEvent: {actionName: "dismiss"}})
  expect(screen.queryByTestId(cardId("two"))).toBeNull()
  expect(mockStop).toHaveBeenCalledTimes(2)

  // Once the store acknowledges the stop, a later launch can appear again.
  mockApps = []
  view.rerender(tray())
  await act(async () => {})
  mockApps = [{packageName: "one", name: "one"} as ClientApp]
  view.rerender(tray())
  await act(async () => {})
  expect(screen.getByTestId(cardId("one"))).toBeTruthy()
})
