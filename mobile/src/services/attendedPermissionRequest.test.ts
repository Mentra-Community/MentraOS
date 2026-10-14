import type {AppPermissionReceipt, AppPermissionSnapshot} from "@mentra/engine"
import {AppState, type AppStateStatus} from "react-native"
const mockWrite = jest.fn()
const mockStatus = jest.fn()
const mockRequest = jest.fn()
let mockAppState: AppStateStatus = "active"
let appStateListener: ((state: AppStateStatus) => void) | undefined
const mockRemoveListener = jest.fn()
const changeState = (state: AppStateStatus) => {
  mockAppState = state
  appStateListener?.(state)
}
jest.mock("@mentra/engine", () => ({
  engine: {
    permissions: {
      writeStatusReceipt: (...args: unknown[]) => mockWrite(...args),
      status: () => mockStatus(),
      request: (...args: unknown[]) => mockRequest(...args),
    },
  },
  BgTimer: {
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  },
}))
Object.defineProperty(AppState, "currentState", {configurable: true, get: () => mockAppState})
import {parseAttendedPermissionRequest, requestAttendedPermissions} from "./attendedPermissionRequest"
const link = (features = "camera,microphone,location,bluetooth", id = "batch-1", timeout = 125000) =>
  `com.mentra://test/request-permissions?request_id=${id}&readback_id=${id}-readback&features=${features}&timeout_ms=${timeout}`
const snapshot = (): AppPermissionSnapshot => ({
  schemaVersion: 1,
  observedAt: "2026-10-13T23:00:00.000Z",
  identity: {
    pid: 100,
    uid: 501,
    bundleId: "com.mentra.mentra",
    bundlePath: "/Mentra.app",
    executablePath: "/Mentra.app/Mentra",
    version: "3.3.0",
    build: "894",
  },
  locationServicesEnabled: true,
  permissions: {
    camera: {status: "denied", rawStatus: "notDetermined"},
    microphone: {status: "denied", rawStatus: "notDetermined"},
    location: {status: "denied", rawStatus: "notDetermined"},
    bluetooth: {status: "denied", rawStatus: "notDetermined"},
    localNetwork: {status: "unknown", rawStatus: null},
  },
})
let current: AppPermissionSnapshot
beforeEach(() => {
  jest.useFakeTimers()
  jest.clearAllMocks()
  mockAppState = "active"
  appStateListener = undefined
  jest.spyOn(AppState, "addEventListener").mockImplementation((_event, listener) => {
    appStateListener = listener
    return {remove: mockRemoveListener}
  })
  current = snapshot()
  mockWrite.mockImplementation(async (requestId: string): Promise<AppPermissionReceipt> => ({...current, requestId}))
  mockStatus.mockImplementation(async () => current)
  mockRequest.mockResolvedValue(true)
})
afterEach(() => jest.useRealTimers())

test("selected features request once, observe between requests, and publish a distinct raw readback", async () => {
  const result = await requestAttendedPermissions(link())
  expect(mockRequest.mock.calls).toEqual([["camera"], ["microphone"], ["location"], ["bluetooth"]])
  expect(mockStatus).toHaveBeenCalledTimes(3)
  expect(mockWrite.mock.calls).toEqual([["batch-1"], ["batch-1-readback"]])
  expect(result.receipt.permissions.camera.status).toBe("denied") // true is not grant proof
  expect(result.actions.every((action) => action.action === "requested")).toBe(true)
  expect(jest.getTimerCount()).toBe(0)
  expect(mockRemoveListener).toHaveBeenCalledTimes(1)
})
test("granted, denied, restricted and unknown states stay passive", async () => {
  current.permissions.camera = {status: "granted", rawStatus: "authorized"}
  current.permissions.microphone = {status: "blocked", rawStatus: "denied"}
  current.permissions.location = {status: "unavailable", rawStatus: "restricted"}
  current.permissions.bluetooth = {status: "unknown", rawStatus: "futureStatus"}
  const result = await requestAttendedPermissions(link())
  expect(mockRequest).not.toHaveBeenCalled()
  expect(result.actions.map((action) => action.nextAction)).toEqual([
    "already-granted",
    "open-app-settings",
    "system-restriction",
    "unverified-status",
  ])
  expect(result.receipt.permissions.localNetwork).toEqual({status: "unknown", rawStatus: null})
})
test("disabled global Location Services is a Settings action without an app request", async () => {
  current.locationServicesEnabled = false
  const result = await requestAttendedPermissions(link("location"))
  expect(mockRequest).not.toHaveBeenCalled()
  expect(result.actions).toEqual([
    {feature: "location", action: "not-requested", nextAction: "enable-location-services"},
  ])
})
test("a current grant change before a later request is honored", async () => {
  mockRequest.mockImplementationOnce(async () => {
    current.permissions.microphone = {status: "granted", rawStatus: "authorized"}
    return false
  })
  await requestAttendedPermissions(link("camera,microphone"))
  expect(mockRequest.mock.calls).toEqual([["camera"]])
})
test("a settled request failure continues independent selected checks without fabricating a grant", async () => {
  mockRequest.mockRejectedValueOnce(new Error("native unavailable"))
  const result = await requestAttendedPermissions(link("camera,microphone"))
  expect(mockRequest.mock.calls).toEqual([["camera"], ["microphone"]])
  expect(result.actions[0]).toEqual({feature: "camera", action: "request-failed", nextAction: "unverified-status"})
  expect(result.receipt.requestId).toBe("batch-1-readback")
})
test("initial status failure requests nothing and produces no final readback", async () => {
  mockWrite.mockRejectedValueOnce(new Error("unavailable status"))
  await expect(requestAttendedPermissions(link())).rejects.toThrow("unavailable status")
  expect(mockRequest).not.toHaveBeenCalled()
  expect(mockWrite).toHaveBeenCalledTimes(1)
  expect(jest.getTimerCount()).toBe(0)
})
test("foreground is required before any observation or request", async () => {
  mockAppState = "background"
  await expect(requestAttendedPermissions(link())).rejects.toThrow("foregrounded")
  expect(mockWrite).not.toHaveBeenCalled()
})
test("deadline rejects, prevents overlap, and stops later requests after native settlement", async () => {
  let settle!: (value: boolean) => void
  mockRequest.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        settle = resolve
      }),
  )
  const pending = requestAttendedPermissions(link("camera,microphone", "deadline", 1000))
  const rejected = expect(pending).rejects.toThrow("native consent may still be outstanding")
  await Promise.resolve()
  await Promise.resolve()
  jest.advanceTimersByTime(1000)
  await rejected
  await expect(requestAttendedPermissions(link("camera", "overlap"))).rejects.toThrow("still settling")
  expect(mockWrite.mock.calls).toEqual([["deadline"]])
  settle(true)
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(mockRequest).toHaveBeenCalledTimes(1)
  expect(mockWrite).toHaveBeenCalledTimes(1)
  await expect(requestAttendedPermissions(link("camera", "next"))).resolves.toMatchObject({requestId: "next"})
})
test("simultaneous different nonces do not create overlapping requests", async () => {
  let settle!: (value: boolean) => void
  mockRequest.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        settle = resolve
      }),
  )
  const first = requestAttendedPermissions(link("camera", "first"))
  await expect(requestAttendedPermissions(link("microphone", "second"))).rejects.toThrow("still settling")
  await Promise.resolve()
  await Promise.resolve()
  settle(false)
  await first
})
test.each([
  "https://example.com/test/request-permissions?request_id=batch&readback_id=read&features=camera&timeout_ms=1000",
  link("localNetwork"),
  link("local_wifi"),
  link("camera,camera"),
  link("camera,microphone,location,bluetooth,camera"),
  link(""),
  link("camera").replace("batch-1-readback", "batch-1"),
  link("camera").replace("request-permissions", "permissions"),
  link("camera") + "&request_id=duplicate",
  link("camera") + "&output=/tmp/result",
  link("camera") + "#fragment",
  link("camera", "x".repeat(161)),
  link("camera", "batch", 999),
  link("camera", "batch", 125001),
])("invalid commands refuse before observing or requesting: %s", async (url) => {
  expect(() => parseAttendedPermissionRequest(url)).toThrow("attended permission link")
  await expect(requestAttendedPermissions(url)).rejects.toThrow()
  expect(mockWrite).not.toHaveBeenCalled()
  expect(mockRequest).not.toHaveBeenCalled()
})

test("final native readback failure rejects instead of advertising completion", async () => {
  mockWrite
    .mockImplementationOnce(async (requestId: string) => ({...current, requestId}))
    .mockRejectedValueOnce(new Error("readback unavailable"))
  await expect(requestAttendedPermissions(link("camera"))).rejects.toThrow("readback unavailable")
  expect(mockRequest).toHaveBeenCalledTimes(1)
  expect(jest.getTimerCount()).toBe(0)
})
test("an unknown state is never eligible merely because its raw string is notDetermined", async () => {
  current.permissions.camera = {status: "unknown", rawStatus: "notDetermined"}
  await requestAttendedPermissions(link("camera"))
  expect(mockRequest).not.toHaveBeenCalled()
})
test("leaving the foreground after one request stops later independent prompts", async () => {
  mockRequest.mockImplementationOnce(async () => {
    mockAppState = "background"
    return true
  })
  await expect(requestAttendedPermissions(link("camera,microphone"))).rejects.toThrow("foregrounded")
  expect(mockRequest.mock.calls).toEqual([["camera"]])
  expect(mockWrite.mock.calls).toEqual([["batch-1"]])
})
test("elapsed wall-clock deadline stops later requests even when the iOS JS timer was suspended", async () => {
  mockRequest.mockImplementationOnce(async () => {
    jest.setSystemTime(Date.now() + 1001)
    return true
  })
  await expect(requestAttendedPermissions(link("camera,microphone", "suspended", 1000))).rejects.toThrow(
    "deadline reached",
  )
  expect(mockRequest.mock.calls).toEqual([["camera"]])
  expect(mockWrite.mock.calls).toEqual([["suspended"]])
})

test("final native state reports the actual missing action after a denied request", async () => {
  mockRequest.mockImplementationOnce(async () => {
    current.permissions.camera = {status: "blocked", rawStatus: "denied"}
    return false
  })
  const result = await requestAttendedPermissions(link("camera"))
  expect(result.missing).toEqual([{feature: "camera", nextAction: "open-app-settings"}])
})
test("a native affirmative final observation leaves no missing selected requirement", async () => {
  mockRequest.mockImplementationOnce(async () => {
    current.permissions.camera = {status: "granted", rawStatus: "authorized"}
    return false
  })
  const result = await requestAttendedPermissions(link("camera"))
  expect(result.missing).toEqual([])
  expect(result.receipt.permissions.camera.status).toBe("granted")
})

test("a background-and-return departure while consent is pending never resumes later prompts", async () => {
  let settle!: (value: boolean) => void
  mockRequest.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        settle = resolve
      }),
  )
  const pending = requestAttendedPermissions(link("camera,microphone", "left"))
  const rejected = expect(pending).rejects.toThrow("foregrounded")
  await Promise.resolve()
  await Promise.resolve()
  changeState("background")
  changeState("active")
  await expect(requestAttendedPermissions(link("camera", "overlap"))).rejects.toThrow("still settling")
  expect(mockRemoveListener).not.toHaveBeenCalled()
  settle(true)
  await rejected
  expect(mockRequest.mock.calls).toEqual([["camera"]])
  expect(mockWrite.mock.calls).toEqual([["left"]])
  expect(mockRemoveListener).toHaveBeenCalledTimes(1)
})
test("an inactive native-consent transition and return does not count as leaving the attended session", async () => {
  mockRequest.mockImplementationOnce(async () => {
    changeState("inactive")
    changeState("active")
    return true
  })
  await requestAttendedPermissions(link("camera,microphone"))
  expect(mockRequest.mock.calls).toEqual([["camera"], ["microphone"]])
  expect(mockRemoveListener).toHaveBeenCalledTimes(1)
})
