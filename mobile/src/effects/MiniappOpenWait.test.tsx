import {act, fireEvent, render, screen} from "@testing-library/react-native"
import type {ClientApp} from "@mentra/engine"
import {useRef} from "react"

import {DEFAULT_MINIAPPS_IDLE, useDefaultMiniappsStore} from "@/stores/defaultMiniapps"
import {startMiniappOpenWait, useMiniappOpenWaitStore} from "@/stores/miniappOpenWait"

import {MiniappOpenWait} from "./MiniappOpenWait"

let mockApps: ClientApp[] = []
const mockListeners = new Set<() => void>()
const mockPrioritize = jest.fn()
jest.mock("@mentra/engine", () => {
  const {useSyncExternalStore} = require("react")
  const subscribe = (listener: () => void) => {
    mockListeners.add(listener)
    return () => mockListeners.delete(listener)
  }
  return {
    useApps: () => useSyncExternalStore(subscribe, () => mockApps),
    engine: {miniapps: {list: () => mockApps}},
  }
})
jest.mock("@/services/miniapps/defaultMiniapps", () => ({
  defaultMiniapps: {prioritize: (...args: unknown[]) => mockPrioritize(...args)},
}))
jest.mock("@/components/miniapp/MiniappSplash", () => {
  const {Text} = require("react-native")
  return function MockMiniappSplash({name, label, error}: {name?: string; label?: string; error?: string}) {
    return <Text testID="splash">{[name, label, error].filter(Boolean).join(" | ")}</Text>
  }
})
jest.mock("@/components/ignite", () => ({Icon: () => null}))
jest.mock("@/contexts/SaferAreaContext", () => ({useSaferAreaInsets: () => ({top: 0, bottom: 0})}))
jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({theme: {colors: {background: "white", text: "black"}}}),
}))
jest.mock("@/i18n", () => ({
  translate: (key: string, options?: {app?: string}) => (options?.app ? `${key}:${options.app}` : key),
}))

// The real shared value needs the UI runtime; a ref holds the same value here.
function useMockSharedValue(initial: unknown) {
  return useRef({value: initial}).current
}
require("react-native-reanimated").useSharedValue = useMockSharedValue

const ai = {packageName: "com.mentra.ai", name: "Mentra AI", logoUrl: "https://host/icon.png"} as ClientApp

function setApps(apps: ClientApp[]) {
  mockApps = apps
  for (const listener of mockListeners) listener()
}

beforeEach(() => {
  mockApps = []
  mockPrioritize.mockReset()
  useMiniappOpenWaitStore.setState({wait: null})
  useDefaultMiniappsStore.setState({...DEFAULT_MINIAPPS_IDLE, status: "installing", pending: ["com.mentra.ai"]})
})

test("a default still installing waits behind its splash, installs next, then opens in place", async () => {
  const open = jest.fn(async () => {})
  startMiniappOpenWait(ai, open)
  render(<MiniappOpenWait />)

  expect(screen.getByTestId("splash").props.children).toBe("Mentra AI | home:miniappInstalling")
  expect(mockPrioritize).toHaveBeenCalledWith("com.mentra.ai")
  expect(open).not.toHaveBeenCalled()

  const installed = {...ai, logoUrl: "file:///icon.png"} as ClientApp
  await act(async () => {
    setApps([installed])
    useDefaultMiniappsStore.setState({status: "idle", pending: []})
  })

  expect(open).toHaveBeenCalledWith(installed)
  expect(useMiniappOpenWaitStore.getState().wait).toBeNull()
  expect(screen.queryByTestId("miniapp-open-wait")).toBeNull()
})

test("says the download waits for a connection, and when nothing will install it", async () => {
  useDefaultMiniappsStore.setState({status: "waiting"})
  startMiniappOpenWait(
    ai,
    jest.fn(async () => {}),
  )
  render(<MiniappOpenWait />)
  expect(screen.getByTestId("splash").props.children).toBe("Mentra AI | home:miniappWaitingForConnection")

  await act(async () => useDefaultMiniappsStore.setState({status: "idle", pending: [], failed: ["com.mentra.ai"]}))
  expect(screen.getByTestId("splash").props.children).toBe("Mentra AI | home:miniappInstallFailed:Mentra AI")
})

test("an updating miniapp waits for its update without moving the install queue", async () => {
  setApps([{...ai, updating: true} as ClientApp])
  const open = jest.fn(async () => {})
  startMiniappOpenWait(ai, open)
  render(<MiniappOpenWait />)

  expect(screen.getByTestId("splash").props.children).toBe("Mentra AI | home:miniappUpdating")
  expect(mockPrioritize).not.toHaveBeenCalled()

  await act(async () => setApps([{...ai, updating: false} as ClientApp]))
  expect(open).toHaveBeenCalledTimes(1)
})

test("closing leaves the wait, and nothing opens afterwards", async () => {
  const open = jest.fn(async () => {})
  startMiniappOpenWait(ai, open)
  render(<MiniappOpenWait />)

  await act(async () => fireEvent.press(screen.getByTestId("miniapp-open-wait.close")))
  expect(screen.queryByTestId("miniapp-open-wait")).toBeNull()

  await act(async () => setApps([ai]))
  expect(open).not.toHaveBeenCalled()
})
