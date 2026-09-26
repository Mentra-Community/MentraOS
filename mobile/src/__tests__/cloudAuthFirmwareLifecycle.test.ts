import * as bootstrap from "@/../modules/engine/src/runtime/bootstrap"
import {firmwareUpdates} from "@/../modules/engine/src/facades/firmwareUpdates"
import {cloudClientService} from "@/../modules/engine/src/services/CloudClientService"

const mockStartAvailability = jest.fn(async () => {})
const mockStopAvailability = jest.fn()
jest.mock("@/../modules/engine/src/devices/mentra-live/availabilityRuntime", () => ({
  startLiveAvailability: () => mockStartAvailability(),
  stopLiveAvailability: () => mockStopAvailability(),
}))
jest.mock("@mentra/cloud-client/react-native", () => ({
  CloudClient: jest.fn(() => {
    throw new Error("No cloud transport in this lifecycle test")
  }),
  setNativeHttp: jest.fn(),
  setNativeUdp: jest.fn(),
  setSecureStorage: jest.fn(),
}))

let callback: (event: string, session: {token?: string | null} | null) => void
beforeEach(async () => {
  jest.clearAllMocks()
  bootstrap.resetForTests()
  bootstrap.configure({
    auth: {
      getSubjectToken: async () => ({token: "token", type: "supabase"}),
      onStateChange: (listener) => {
        callback = listener
        return {unsubscribe: () => {}}
      },
    },
    config: {coreUrl: "https://core.example", runtimeUrl: "https://runtime.example"},
  })
  await bootstrap.start()
  // Registration precedes transport construction; hardware/cloud I/O is outside this test.
  expect(() => cloudClientService.init()).toThrow("No cloud transport")
  jest.spyOn(cloudClientService, "reconnect").mockImplementation(() => {})
})
afterEach(() => {
  cloudClientService.stop()
  bootstrap.resetForTests()
  jest.restoreAllMocks()
})

it("suspends retained work and availability through the headless Engine auth callback", () => {
  const suspend = jest.spyOn(firmwareUpdates, "suspendNewWork")
  callback("SIGNED_OUT", null)
  expect(suspend).toHaveBeenCalledTimes(1)
  expect(mockStopAvailability).toHaveBeenCalledTimes(1)
  expect(mockStartAvailability).not.toHaveBeenCalled()
})

it("resumes discovery on sign-in without resuming old approval or a stopped runtime", async () => {
  const suspend = jest.spyOn(firmwareUpdates, "suspendNewWork")
  callback("SIGNED_OUT", null)
  callback("SIGNED_IN", {token: "new-account"})
  expect(suspend).toHaveBeenCalledTimes(1)
  expect(mockStartAvailability).toHaveBeenCalledTimes(1)
  callback("SIGNED_IN", {token: "refreshed"})
  expect(suspend).toHaveBeenCalledTimes(1)
  await bootstrap.stop()
  callback("SIGNED_IN", {token: "later"})
  expect(mockStartAvailability).toHaveBeenCalledTimes(2)
})
