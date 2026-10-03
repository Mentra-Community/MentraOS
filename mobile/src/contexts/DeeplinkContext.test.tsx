import {act, render} from "@testing-library/react-native"
import * as Linking from "expo-linking"

import {DeeplinkProvider, useDeeplink} from "./DeeplinkContext"

const mockSetSplashEnabled = jest.fn()
const mockReplaceAll = jest.fn()
const mockReplace = jest.fn()
const mockCompleteOAuthHandoff = jest.fn()
const mockCompleteSignupVerification = jest.fn()
let mockPendingRoute: string | null = null

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
      replace: mockReplace,
      setAnimation: jest.fn(),
      setPendingRoute: (url: string) => {
        mockPendingRoute = url
      },
      getPendingRoute: () => mockPendingRoute,
    }),
  },
}))
jest.mock("@/utils/auth/authClient", () => ({
  __esModule: true,
  default: {
    getSession: jest.fn(async () => ({is_error: () => false, value: {token: undefined}})),
    completeOAuthHandoff: (...args: unknown[]) => mockCompleteOAuthHandoff(...args),
    completeSignupVerification: (...args: unknown[]) => mockCompleteSignupVerification(...args),
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
  mockCompleteSignupVerification.mockResolvedValue({is_error: () => false})
  mockPendingRoute = null
  jest.mocked(Linking.getInitialURL).mockResolvedValue(null)
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

const signupCallback = "com.mentra://auth/callback#access_token=signup-token&refresh_token=provider-refresh&type=signup"

it("waits for signup sign-in before navigating and ignores duplicate callbacks", async () => {
  let finish!: (result: {is_error: () => boolean}) => void
  mockCompleteSignupVerification.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    }),
  )
  render(
    <DeeplinkProvider>
      <Probe />
    </DeeplinkProvider>,
  )
  let processing!: Promise<void>
  await act(async () => {
    processing = processUrl(signupCallback)
  })
  expect(mockCompleteSignupVerification).toHaveBeenCalledWith("signup-token")
  expect(mockReplaceAll).not.toHaveBeenCalled()
  await act(async () => {
    finish({is_error: () => false})
    await processing
    await processUrl(signupCallback)
  })
  expect(mockCompleteSignupVerification).toHaveBeenCalledTimes(1)
  expect(mockReplaceAll).toHaveBeenCalledWith("/")
  expect(mockSetSplashEnabled).toHaveBeenLastCalledWith(false)
})

it("completes a signup link that launches the app", async () => {
  jest.mocked(Linking.getInitialURL).mockResolvedValue(signupCallback)
  render(
    <DeeplinkProvider>
      <Probe />
    </DeeplinkProvider>,
  )
  await act(async () => {
    await Promise.resolve()
  })
  await act(async () => {
    await jest.runAllTimersAsync()
  })
  expect(mockCompleteSignupVerification).toHaveBeenCalledWith("signup-token")
  expect(mockReplaceAll).toHaveBeenCalledWith("/")
})

it("shows a login error when signup exchange fails", async () => {
  mockCompleteSignupVerification.mockResolvedValue({is_error: () => true, error: new Error("expired")})
  render(
    <DeeplinkProvider>
      <Probe />
    </DeeplinkProvider>,
  )
  await act(async () => {
    await processUrl(signupCallback)
  })
  expect(mockReplace).toHaveBeenCalledWith("/auth/start?authError=invalid_grant")
  expect(mockReplaceAll).not.toHaveBeenCalled()
  expect(mockSetSplashEnabled).toHaveBeenLastCalledWith(false)
})

it("does not exchange an expired confirmation link", async () => {
  render(
    <DeeplinkProvider>
      <Probe />
    </DeeplinkProvider>,
  )
  await act(async () => {
    await processUrl("com.mentra://auth/callback#error=access_denied&error_code=otp_expired&type=signup")
  })
  expect(mockCompleteSignupVerification).not.toHaveBeenCalled()
  expect(mockReplace).toHaveBeenCalledWith("/auth/start?authError=otp_expired")
})
