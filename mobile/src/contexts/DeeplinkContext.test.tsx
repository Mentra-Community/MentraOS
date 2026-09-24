import {act, fireEvent, render} from "@testing-library/react-native"
import * as Linking from "expo-linking"

import {DeeplinkProvider, useDeeplink} from "./DeeplinkContext"

const mockSetSplashEnabled = jest.fn()
const mockReplaceAll = jest.fn()
const mockCompleteOAuthHandoff = jest.fn()
const mockPush = jest.fn()
const mockSetPendingRoute = jest.fn()
const mockGetSession = jest.fn()
const mockIncidentRequest = jest.fn()

jest.mock("@/components/diagnostics/IncidentReportRequest", () => ({
  __esModule: true,
  default: (props: unknown) => {
    mockIncidentRequest(props)
    const {Pressable} = require("react-native")
    return <Pressable testID="incident-report-done" onPress={(props as {onDismiss: () => void}).onDismiss} />
  },
}))

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
    getState: () => ({
      replaceAll: mockReplaceAll,
      replace: jest.fn(),
      setAnimation: jest.fn(),
      push: mockPush,
      setPendingRoute: mockSetPendingRoute,
    }),
  },
}))
jest.mock("@/utils/auth/authClient", () => ({
  __esModule: true,
  default: {
    getSession: (...args: unknown[]) => mockGetSession(...args),
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
  mockGetSession.mockResolvedValue({is_error: () => false, value: {token: undefined}})
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

const incidentUrl =
  "com.mentra://test/submit-incident-report?alert_id=run-1&failure_code=ota_failed&failure_message=failed%20%26%20stopped"

it("queues an incident link for authentication without executing its route", async () => {
  render(
    <DeeplinkProvider>
      <Probe />
    </DeeplinkProvider>,
  )
  await act(async () => {
    await processUrl(incidentUrl)
  })
  expect(mockSetPendingRoute).toHaveBeenCalledWith(incidentUrl)
  expect(mockPush).not.toHaveBeenCalled()
  expect(mockIncidentRequest).not.toHaveBeenCalled()
})

it("shows a dismissible authenticated incident modal without changing the existing navigation", async () => {
  mockGetSession.mockResolvedValue({is_error: () => false, value: {token: "test-session"}})
  const tree = render(
    <DeeplinkProvider>
      <Probe />
    </DeeplinkProvider>,
  )
  await act(async () => {
    await processUrl(incidentUrl)
  })
  expect(mockIncidentRequest).toHaveBeenLastCalledWith(
    expect.objectContaining({
      params: {
        alert_id: "run-1",
        failure_code: "ota_failed",
        failure_message: "failed & stopped",
      },
    }),
  )
  expect(mockPush).not.toHaveBeenCalled()
  expect(mockReplaceAll).not.toHaveBeenCalled()
  fireEvent.press(tree.getByTestId("incident-report-done"))
  expect(tree.queryByTestId("incident-report-done")).toBeNull()
})
