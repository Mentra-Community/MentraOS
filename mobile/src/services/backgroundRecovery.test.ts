import {engine} from "@mentra/engine"
import mantle from "@/services/MantleManager"
import {createDeploymentAuthProvider} from "@/services/deployment/auth"
import {deploymentStore} from "@/services/deployment/store"
import mentraAuth from "@/utils/auth/authClient"
import {recoverBackgroundRuntime} from "./backgroundRecovery"

jest.mock("@mentra/engine", () => ({
  engine: {
    pairing: {readiness: jest.fn()},
    glasses: {hasDefaultDevice: jest.fn(), connectDefault: jest.fn()},
  },
}))
jest.mock("@/services/MantleManager", () => ({
  __esModule: true,
  default: {
    init: jest.fn(),
    waitForMiniapps: jest.fn(),
  },
}))
jest.mock("@/services/deployment/store", () => ({
  deploymentStore: {
    isResolved: jest.fn(),
    isSelectingWorkspace: jest.fn(),
    getActive: jest.fn(),
  },
}))
jest.mock("@/services/deployment/auth", () => ({createDeploymentAuthProvider: jest.fn()}))
jest.mock("@/utils/auth/authClient", () => ({__esModule: true, default: {getSession: jest.fn()}}))

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(deploymentStore.isResolved).mockReturnValue(true)
  jest.mocked(deploymentStore.isSelectingWorkspace).mockReturnValue(false)
  ;(deploymentStore.getActive as jest.Mock).mockReturnValue({kind: "consumer"})
  ;(mentraAuth.getSession as jest.Mock).mockResolvedValue({is_error: () => false, value: {token: "session"}})
  ;(mantle.init as jest.Mock).mockResolvedValue(undefined)
  ;(mantle.waitForMiniapps as jest.Mock).mockResolvedValue(undefined)
  ;(engine.pairing.readiness as jest.Mock).mockReturnValue({connected: false, nativeLinkBusy: false})
  ;(engine.glasses.hasDefaultDevice as jest.Mock).mockResolvedValue(true)
  ;(engine.glasses.connectDefault as jest.Mock).mockResolvedValue(undefined)
})

test("restores runtime and waits for miniapps before connecting", async () => {
  const events: string[] = []
  ;(mantle.init as jest.Mock).mockImplementation(async () => {
    events.push("runtime")
  })
  ;(mantle.waitForMiniapps as jest.Mock).mockImplementation(async () => {
    events.push("miniapps")
  })
  ;(engine.glasses.connectDefault as jest.Mock).mockImplementation(async () => {
    events.push("connect")
  })
  await recoverBackgroundRuntime()
  expect(mantle.init).toHaveBeenCalledWith({background: true})
  expect(events).toEqual(["runtime", "miniapps", "connect"])
})

test("coalesces concurrent recovery requests", async () => {
  const first = recoverBackgroundRuntime()
  const second = recoverBackgroundRuntime()
  expect(second).toBe(first)
  await Promise.all([first, second])
  expect(mantle.init).toHaveBeenCalledTimes(1)
  expect(engine.glasses.connectDefault).toHaveBeenCalledTimes(1)
})

test.each([
  {connected: true, nativeLinkBusy: false},
  {connected: false, nativeLinkBusy: true},
])("does not interrupt an existing native connection: %j", async (readiness) => {
  ;(engine.pairing.readiness as jest.Mock).mockReturnValue(readiness)
  await recoverBackgroundRuntime()
  expect(mantle.waitForMiniapps).toHaveBeenCalled()
  expect(engine.glasses.connectDefault).not.toHaveBeenCalled()
})

test("does not resurrect a signed-out session", async () => {
  ;(mentraAuth.getSession as jest.Mock).mockResolvedValue({is_error: () => false, value: null})
  await recoverBackgroundRuntime()
  expect(mantle.init).not.toHaveBeenCalled()
  expect(engine.glasses.connectDefault).not.toHaveBeenCalled()
})

test("does not start services during unresolved deployment selection", async () => {
  jest.mocked(deploymentStore.isResolved).mockReturnValue(false)
  await recoverBackgroundRuntime()
  expect(mentraAuth.getSession).not.toHaveBeenCalled()
  expect(mantle.init).not.toHaveBeenCalled()
})

test("a failed startup can be retried", async () => {
  ;(mantle.init as jest.Mock).mockRejectedValueOnce(new Error("startup failed"))
  await expect(recoverBackgroundRuntime()).rejects.toThrow("startup failed")
  await recoverBackgroundRuntime()
  expect(mantle.init).toHaveBeenCalledTimes(2)
  expect(engine.glasses.connectDefault).toHaveBeenCalledTimes(1)
})

test("workspace recovery requires a silently restored access token", async () => {
  ;(deploymentStore.getActive as jest.Mock).mockReturnValue({kind: "workspace"})
  ;(createDeploymentAuthProvider as jest.Mock).mockReturnValue({
    getSession: jest.fn().mockResolvedValue({identity: {subject: "cached-account"}}),
  })
  await recoverBackgroundRuntime()
  expect(mantle.init).not.toHaveBeenCalled()
  expect(mentraAuth.getSession).not.toHaveBeenCalled()
})

test("a signed-in workspace restores through the same startup path", async () => {
  ;(deploymentStore.getActive as jest.Mock).mockReturnValue({kind: "workspace"})
  ;(createDeploymentAuthProvider as jest.Mock).mockReturnValue({
    getSession: jest.fn().mockResolvedValue({accessToken: "workspace-session"}),
  })
  await recoverBackgroundRuntime()
  expect(mantle.init).toHaveBeenCalledWith({background: true})
  expect(engine.glasses.connectDefault).toHaveBeenCalled()
  expect(mentraAuth.getSession).not.toHaveBeenCalled()
})
