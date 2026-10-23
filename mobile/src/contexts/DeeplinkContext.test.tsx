import {act, fireEvent, render} from "@testing-library/react-native"
import * as Linking from "expo-linking"

import {DeeplinkProvider, useDeeplink} from "./DeeplinkContext"

const mockSetSplashEnabled = jest.fn()
const mockReplaceAll = jest.fn()
const mockReplace = jest.fn()
const mockCompleteOAuthHandoff = jest.fn()
const mockPush = jest.fn()
const mockSetPendingRoute = jest.fn()
const mockGetSession = jest.fn()
const mockIncidentRequest = jest.fn()
const mockLoadAuthoringMiniapp = jest.fn()
const mockPublishPermissionStatus = jest.fn()
const mockRequestAttendedPermissions = jest.fn()
jest.mock("@/services/attendedPermissionRequest", () => ({requestAttendedPermissions: (...args: unknown[]) => mockRequestAttendedPermissions(...args)}))
jest.mock("@/services/permissionStatusRequest", () => ({
  publishPermissionStatusRequest: (...args: unknown[]) => mockPublishPermissionStatus(...args),
}))
jest.mock("@/services/miniapps/loadAuthoringMiniapp", () => ({
  loadAuthoringMiniapp: (...args: unknown[]) => mockLoadAuthoringMiniapp(...args),
}))

jest.mock("@/components/diagnostics/IncidentReportRequest", () => ({
  __esModule: true,
  default: (props: unknown) => {
    mockIncidentRequest(props)
    const {Pressable} = require("react-native")
    return <Pressable testID="incident-report-done" onPress={(props as {onDismiss: () => void}).onDismiss} />
  },
}))
const mockCompleteSignupVerification = jest.fn()
let mockPendingRoute: string | null = null

jest.mock("expo-linking", () => ({
  addEventListener: jest.fn(() => ({remove: jest.fn()})),
  getInitialURL: jest.fn(async () => null),
}))
jest.mock("expo-web-browser", () => ({dismissBrowser: jest.fn()}))
const mockMiniappsList = jest.fn((): Array<{packageName: string; name: string}> => [])
const mockMiniappsStart = jest.fn()
const mockSetForeground = jest.fn()
jest.mock("@mentra/engine", () => ({
  BgTimer: {setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay)},
  engine: {
    miniapps: {
      list: () => mockMiniappsList(),
      start: (...args: unknown[]) => mockMiniappsStart(...args),
      setForeground: (...args: unknown[]) => mockSetForeground(...args),
    },
  },
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
      push: mockPush,
      setPendingRoute: mockSetPendingRoute,
      getPendingRoute: () => mockPendingRoute,
    }),
  },
}))
jest.mock("@/utils/auth/authClient", () => ({
  __esModule: true,
  default: {
    getSession: (...args: unknown[]) => mockGetSession(...args),
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
  mockGetSession.mockResolvedValue({is_error: () => false, value: {token: undefined}})
  mockCompleteSignupVerification.mockResolvedValue({is_error: () => false})
  mockRequestAttendedPermissions.mockResolvedValue({requestId: "batch-1"})
  mockPendingRoute = null
  mockSetPendingRoute.mockImplementation((url: string) => {
    mockPendingRoute = url
  })
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

const incidentUrl =
  "com.mentra://test/submit-incident-report?alert_id=run-1&failure_code=ota_failed&failure_message=failed%20%26%20stopped"

it("handles passive permission status without auth, modal, or navigation", async () => {
  render(<DeeplinkProvider><Probe /></DeeplinkProvider>)
  const url = "com.mentra://test/permissions?request_id=read-1"
  await act(async () => { await processUrl(url) })
  expect(mockPublishPermissionStatus).toHaveBeenCalledWith(url)
  expect(mockGetSession).not.toHaveBeenCalled()
  expect(mockIncidentRequest).not.toHaveBeenCalled()
  expect(mockSetPendingRoute).not.toHaveBeenCalled()
  expect(mockPush).not.toHaveBeenCalled()
  expect(mockReplace).not.toHaveBeenCalled()
  expect(mockReplaceAll).not.toHaveBeenCalled()
  expect(mockSetSplashEnabled).not.toHaveBeenCalled()
})

it.each(["success", "failure"])("a pending passive status %s never changes the splash overlay", async (outcome) => {
  let complete!: () => void
  let refuse!: (error: Error) => void
  mockPublishPermissionStatus.mockImplementationOnce(
    () =>
      new Promise<void>((resolve, reject) => {
        complete = resolve
        refuse = reject
      }),
  )
  render(
    <DeeplinkProvider>
      <Probe />
    </DeeplinkProvider>,
  )
  let pending!: Promise<void>
  await act(async () => {
    pending = processUrl("com.mentra://test/permissions?request_id=pending-read")
    await Promise.resolve()
  })
  expect(mockPublishPermissionStatus).toHaveBeenCalledTimes(1)
  expect(mockSetSplashEnabled).not.toHaveBeenCalled()
  await act(async () => {
    if (outcome === "success") complete()
    else refuse(new Error("native status unavailable"))
    await pending
  })
  expect(mockSetSplashEnabled).not.toHaveBeenCalled()
  expect(mockPush).not.toHaveBeenCalled()
  expect(mockReplace).not.toHaveBeenCalled()
  expect(mockReplaceAll).not.toHaveBeenCalled()
})

it("still defers a protected home link to sign-in without running its handler", async () => {
  render(
    <DeeplinkProvider>
      <Probe />
    </DeeplinkProvider>,
  )
  await act(async () => {
    await processUrl("com.mentra://home")
    jest.advanceTimersByTime(100)
  })
  expect(mockGetSession).toHaveBeenCalledTimes(1)
  expect(mockSetPendingRoute).toHaveBeenCalledWith("com.mentra://home")
  expect(mockReplace).toHaveBeenCalledWith("/auth/start")
  expect(mockReplaceAll).not.toHaveBeenCalled()
})

it.each(["signed out", "expired", "unavailable"])(
  "opens the diagnostic modal without auth redirection when the session is %s",
  async (state) => {
    if (state === "expired") mockGetSession.mockResolvedValue({is_error: () => true})
    if (state === "unavailable") mockGetSession.mockRejectedValue(new Error("session unavailable"))
    render(
      <DeeplinkProvider>
        <Probe />
      </DeeplinkProvider>,
    )
    await act(async () => {
      await processUrl(incidentUrl)
      jest.advanceTimersByTime(100)
    })
    expect(mockIncidentRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({params: expect.objectContaining({alert_id: "run-1"})}),
    )
    expect(mockGetSession).not.toHaveBeenCalled()
    expect(mockSetPendingRoute).not.toHaveBeenCalled()
    expect(mockPush).not.toHaveBeenCalled()
    expect(mockReplace).not.toHaveBeenCalled()
    expect(mockReplaceAll).not.toHaveBeenCalled()
  },
)

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

const authoringUrl =
  "com.mentra://test/load-miniapp?package=com.mentra.notes&version=1.0.27&url=http%3A%2F%2F127.0.0.1%3A3000%2Fbundle.zip"
it("handles the native authoring URL without a settings-screen navigation", async () => {
  mockGetSession.mockResolvedValue({is_error: () => false, value: {token: "test-session"}})
  mockLoadAuthoringMiniapp.mockResolvedValue({packageName: "com.mentra.notes", version: "1.0.27"})
  render(
    <DeeplinkProvider>
      <Probe />
    </DeeplinkProvider>,
  )
  await act(async () => {
    await processUrl(authoringUrl)
  })
  expect(mockLoadAuthoringMiniapp).toHaveBeenCalledWith(authoringUrl)
  expect(mockPush).not.toHaveBeenCalled()
})
it("does not install a miniapp without a signed-in session", async () => {
  render(
    <DeeplinkProvider>
      <Probe />
    </DeeplinkProvider>,
  )
  await act(async () => {
    await processUrl(authoringUrl)
  })
  expect(mockLoadAuthoringMiniapp).not.toHaveBeenCalled()
  expect(mockSetPendingRoute).toHaveBeenCalledWith(authoringUrl)
})

it("consumes an auth-deferred authoring link immediately after sign-in exactly once", async () => {
  render(<DeeplinkProvider><Probe /></DeeplinkProvider>)
  const url = "com.mentra://test/load-miniapp?package=com.mentra.notes&version=1.0.27&url=http%3A%2F%2Flocal%2Fbundle.zip"
  await act(async () => {await processUrl(url)})
  expect(mockLoadAuthoringMiniapp).not.toHaveBeenCalled()
  mockGetSession.mockResolvedValue({is_error: () => false, value: {token: "test-session"}})
  mockRequestAttendedPermissions.mockResolvedValue({requestId: "batch-1"})
  mockPendingRoute = null
  await act(async () => {await processUrl(url, false, true); await processUrl(url)})
  expect(mockLoadAuthoringMiniapp).toHaveBeenCalledTimes(1)
})

it("consumes a cold-start authoring link during the startup delay exactly once", async () => {
  mockGetSession.mockResolvedValue({is_error: () => false, value: {token: "test-session"}})
  render(<DeeplinkProvider><Probe /></DeeplinkProvider>)
  let startup: Promise<void>
  await act(async () => {
    startup = processUrl(authoringUrl, true)
    await Promise.resolve()
  })
  expect(mockPendingRoute).toBe(authoringUrl)
  mockRequestAttendedPermissions.mockResolvedValue({requestId: "batch-1"})
  mockPendingRoute = null
  await act(async () => {
    await processUrl(authoringUrl, false, true)
    await jest.advanceTimersByTimeAsync(1000)
    await startup!
    await processUrl(authoringUrl)
  })
  expect(mockLoadAuthoringMiniapp).toHaveBeenCalledTimes(1)
})

it("ignores a duplicate native event while the cold-start pending route remains set", async () => {
  mockGetSession.mockResolvedValue({is_error: () => false, value: {token: "test-session"}})
  render(<DeeplinkProvider><Probe /></DeeplinkProvider>)
  let startup: Promise<void>
  await act(async () => {
    startup = processUrl(authoringUrl, true)
    await Promise.resolve()
    await processUrl(authoringUrl)
  })
  expect(mockLoadAuthoringMiniapp).not.toHaveBeenCalled()
  await act(async () => {
    await jest.advanceTimersByTimeAsync(1000)
    await startup!
  })
  expect(mockLoadAuthoringMiniapp).toHaveBeenCalledTimes(1)
  expect(mockPendingRoute).toBeNull()
})

it("claims a pending replay before concurrent authentication completes", async () => {
  render(<DeeplinkProvider><Probe /></DeeplinkProvider>)
  await act(async () => {await processUrl(authoringUrl)})
  let authenticated!: (value: unknown) => void
  mockGetSession.mockReturnValue(new Promise(resolve => {authenticated = resolve}))
  let first: Promise<void>
  await act(async () => {
    first = processUrl(authoringUrl, false, true)
    await processUrl(authoringUrl, false, true)
    authenticated({is_error: () => false, value: {token: "test-session"}})
    await first!
  })
  expect(mockLoadAuthoringMiniapp).toHaveBeenCalledTimes(1)
  expect(mockPendingRoute).toBeNull()
})

// Opening the existing controls must not enable Super Mode or change a device setting.
it("opens Super Settings for an authenticated user", async () => {
  mockGetSession.mockResolvedValue({is_error: () => false, value: {token: "signed-in"}})
  render(
    <DeeplinkProvider>
      <Probe />
    </DeeplinkProvider>,
  )
  await act(async () => {
    await processUrl("com.mentra://miniapps/settings/super")
  })
  expect(mockPush).toHaveBeenCalledWith("/miniapps/settings/super")
})

it("explicit attended route requests without auth, an extra page, or splash and leaves passive status separate", async () => {
  render(<DeeplinkProvider><Probe /></DeeplinkProvider>)
  const url = "com.mentra://test/request-permissions?request_id=batch-1&readback_id=read-1&features=camera&timeout_ms=1000"
  await act(async () => { await processUrl(url) })
  expect(mockRequestAttendedPermissions).toHaveBeenCalledWith(url)
  expect(mockPublishPermissionStatus).not.toHaveBeenCalled()
  expect(mockGetSession).not.toHaveBeenCalled()
  expect(mockIncidentRequest).not.toHaveBeenCalled()
  expect(mockPush).not.toHaveBeenCalled()
  expect(mockReplaceAll).not.toHaveBeenCalled()
  expect(mockSetSplashEnabled).not.toHaveBeenCalled()
})

describe("the Gallery link", () => {
  const gallery = {packageName: "com.mentra.camera", name: "Gallery"}
  const galleryUrl = "com.mentra://asg/gallery"

  beforeEach(() => {
    mockGetSession.mockResolvedValue({is_error: () => false, value: {token: "test-session"}})
    mockMiniappsList.mockReturnValue([gallery])
  })

  it("opens Gallery the way a tap on Home does: a user start, then on screen", async () => {
    mockMiniappsStart.mockResolvedValue(true)
    render(
      <DeeplinkProvider>
        <Probe />
      </DeeplinkProvider>,
    )
    await act(async () => {
      await processUrl(galleryUrl)
    })
    expect(mockMiniappsStart).toHaveBeenCalledWith(gallery, {trigger: "user", skipNavigation: true})
    expect(mockSetForeground).toHaveBeenCalledWith("com.mentra.camera")
    expect(mockPush).not.toHaveBeenCalled()
  })

  it("shows nothing when the start is refused, as Home does (glasses not connected, an update running)", async () => {
    mockMiniappsStart.mockResolvedValue(false)
    render(
      <DeeplinkProvider>
        <Probe />
      </DeeplinkProvider>,
    )
    await act(async () => {
      await processUrl(galleryUrl)
    })
    expect(mockSetForeground).not.toHaveBeenCalled()
    expect(mockPush).not.toHaveBeenCalled()
  })

  it("still opens the Gallery screen before the built-in miniapps are registered", async () => {
    mockMiniappsList.mockReturnValue([])
    render(
      <DeeplinkProvider>
        <Probe />
      </DeeplinkProvider>,
    )
    await act(async () => {
      await processUrl(galleryUrl)
    })
    expect(mockMiniappsStart).not.toHaveBeenCalled()
    expect(mockPush).toHaveBeenCalledWith("/asg/gallery")
  })
})
