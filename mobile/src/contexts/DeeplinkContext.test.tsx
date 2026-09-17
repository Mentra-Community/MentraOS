import {act, render} from "@testing-library/react-native"
import * as Linking from "expo-linking"

import {DeeplinkProvider, useDeeplink} from "./DeeplinkContext"

const mockSetSplashEnabled = jest.fn()
const mockReplaceAll = jest.fn()
const mockCompleteOAuthHandoff = jest.fn()

jest.mock("expo-linking", () => ({
  addEventListener: jest.fn(() => ({remove: jest.fn()})),
  getInitialURL: jest.fn(async () => null),
}))
jest.mock("expo-web-browser", () => ({dismissBrowser: jest.fn()}))
jest.mock("@mentra/engine", () => ({
  BgTimer: {setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay)},
}))
jest.mock("@/contexts/SplashLoaderProvider", () => ({
  useSplashLoader: () => ({setSplashEnabled: mockSetSplashEnabled}),
}))
jest.mock("@/stores/navigation", () => ({
  useNavigationStore: {
    getState: () => ({replaceAll: mockReplaceAll, replace: jest.fn(), setAnimation: jest.fn()}),
  },
}))
jest.mock("@/utils/auth/authClient", () => ({
  __esModule: true,
  default: {
    getSession: jest.fn(async () => ({is_error: () => false, value: {token: undefined}})),
    completeOAuthHandoff: (...args: unknown[]) => mockCompleteOAuthHandoff(...args),
  },
}))

let processUrl: ReturnType<typeof useDeeplink>["processUrl"]
function Probe() {
  processUrl = useDeeplink().processUrl
  return null
}

const callback = "com.mentra://auth/callback?code=test-handoff&state=test-state"

beforeEach(() => {
  jest.useFakeTimers()
  jest.clearAllMocks()
  mockCompleteOAuthHandoff.mockResolvedValue({is_error: () => false})
})

afterEach(() => jest.useRealTimers())

it.each(["", "#", "#_=_"])("completes a warm OAuth callback with suffix %j without a timer", async (suffix) => {
  render(
    <DeeplinkProvider>
      <Probe />
    </DeeplinkProvider>,
  )

  await act(async () => {
    await processUrl(callback + suffix)
  })

  expect(mockCompleteOAuthHandoff).toHaveBeenCalledWith({code: "test-handoff", state: "test-state"})
  expect(mockReplaceAll).toHaveBeenCalledWith("/")
  expect(mockSetSplashEnabled).toHaveBeenLastCalledWith(false)
})

it("does not exchange the same native/session callback twice across a provider render", async () => {
  const tree = render(
    <DeeplinkProvider>
      <Probe />
    </DeeplinkProvider>,
  )
  await act(async () => {
    await processUrl(callback)
  })
  tree.rerender(
    <DeeplinkProvider>
      <Probe />
    </DeeplinkProvider>,
  )
  await act(async () => {
    await processUrl(callback)
  })

  expect(mockCompleteOAuthHandoff).toHaveBeenCalledTimes(1)
})

it("clears the splash when an asynchronous callback handler throws", async () => {
  mockCompleteOAuthHandoff.mockRejectedValue(new Error("unexpected completion failure"))
  render(
    <DeeplinkProvider>
      <Probe />
    </DeeplinkProvider>,
  )
  await act(async () => {
    await processUrl(callback)
  })

  expect(mockCompleteOAuthHandoff).toHaveBeenCalledTimes(1)
  expect(mockSetSplashEnabled).toHaveBeenLastCalledWith(false)
})

it("removes its native URL subscription on unmount", () => {
  const tree = render(
    <DeeplinkProvider>
      <Probe />
    </DeeplinkProvider>,
  )
  const subscription = jest.mocked(Linking.addEventListener).mock.results[0].value
  tree.unmount()
  expect(subscription.remove).toHaveBeenCalledTimes(1)
})
