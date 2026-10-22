import {CoreRequestError, CoreResponseError, SessionChangedError} from "@mentra/cloud-client"
import {cloudClientService, notifyFleetWorkspaceLeft, triggerAssignmentReconcile} from "@mentra/engine-host-internal"

import {
  cloudWorkspaceApi,
  installCloudWorkspaceApi,
  WorkspaceApiError,
  toWorkspaceApiError,
} from "@/services/fleet/cloudWorkspaceApi"
import {useMyWorkspaceStore} from "@/services/fleet/myWorkspace"
import {getWorkspaceApi, workspaceErrorCode} from "@/services/fleet/workspaceApi"

type SessionListener = (change: {reason: string; coreUrl: string | null; mentraUserId: string | null}) => void

jest.mock("@mentra/engine-host-internal", () => {
  const listeners = new Set<SessionListener>()
  const session = {current: {coreUrl: "https://core.test", mentraUserId: "user_a" as string | null}}
  return {
    __session: session,
    __listeners: listeners,
    cloudClientService: {
      getCoreSession: jest.fn(() => session.current),
      onCoreSessionChanged: jest.fn((listener: SessionListener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }),
      core: {
        workspaces: {
          mine: jest.fn(),
          pendingInvitations: jest.fn(),
          acceptInvitation: jest.fn(),
          declineInvitation: jest.fn(),
          leave: jest.fn(),
        },
      },
    },
    notifyFleetWorkspaceLeft: jest.fn(),
    triggerAssignmentReconcile: jest.fn(),
  }
})

const host = jest.requireMock("@mentra/engine-host-internal") as {
  __session: {current: {coreUrl: string; mentraUserId: string | null}}
  __listeners: Set<SessionListener>
}
const workspaces = jest.mocked(cloudClientService.core.workspaces)

const WORKSPACE = {
  workspaceId: "ws_1",
  name: "Acme",
  role: "member",
  membershipId: "mem_1",
  joinedAt: "2026-10-01T00:00:00.000Z",
} as never

function signIn(mentraUserId: string | null, reason = "signed_in"): void {
  host.__session.current = {coreUrl: "https://core.test", mentraUserId}
  for (const listener of host.__listeners) listener({reason, coreUrl: "https://core.test", mentraUserId})
}

beforeEach(() => {
  jest.clearAllMocks()
  host.__session.current = {coreUrl: "https://core.test", mentraUserId: "user_a"}
  useMyWorkspaceStore.getState().reset()
})

describe("cloud workspace calls", () => {
  test("each call is made as the signed-in account and unwraps Core's answer", async () => {
    workspaces.mine.mockResolvedValue({workspace: WORKSPACE})
    workspaces.pendingInvitations.mockResolvedValue({invitations: []})
    workspaces.acceptInvitation.mockResolvedValue({workspace: WORKSPACE})
    workspaces.declineInvitation.mockResolvedValue({invitationId: "inv_1", declined: true})

    await expect(cloudWorkspaceApi.mine()).resolves.toBe(WORKSPACE)
    await expect(cloudWorkspaceApi.invitations()).resolves.toEqual([])
    await expect(cloudWorkspaceApi.accept("inv_1")).resolves.toBe(WORKSPACE)
    await expect(cloudWorkspaceApi.decline("inv_1")).resolves.toBeUndefined()

    expect(workspaces.mine).toHaveBeenCalledWith({expectedAccount: "user_a"})
    expect(workspaces.acceptInvitation).toHaveBeenCalledWith("inv_1", {expectedAccount: "user_a"})
    expect(workspaces.declineInvitation).toHaveBeenCalledWith("inv_1", {expectedAccount: "user_a"})
  })

  test("Core's error code is the rejection's code", async () => {
    workspaces.leave.mockRejectedValue(new CoreRequestError(409, "last_owner"))
    workspaces.acceptInvitation.mockRejectedValue(new CoreRequestError(410, "invitation_expired"))

    const leave = await cloudWorkspaceApi.leave().catch((error: unknown) => error)
    expect(leave).toBeInstanceOf(WorkspaceApiError)
    expect(workspaceErrorCode(leave)).toBe("last_owner")
    expect((leave as WorkspaceApiError).status).toBe(409)
    expect(workspaceErrorCode(await cloudWorkspaceApi.accept("inv_1").catch((error: unknown) => error))).toBe(
      "invitation_expired",
    )
    expect(notifyFleetWorkspaceLeft).not.toHaveBeenCalled()
  })

  test("failures Core did not name get their own codes", () => {
    expect(toWorkspaceApiError(new CoreRequestError(0, "network_error")).code).toBe("network_error")
    expect(toWorkspaceApiError(new CoreRequestError(500)).code).toBe("unknown")
    expect(toWorkspaceApiError(new SessionChangedError("other_account")).code).toBe("session_changed")
    expect(toWorkspaceApiError(new CoreResponseError("invalid_shape")).code).toBe("invalid_response")
    expect(toWorkspaceApiError(new Error("boom")).code).toBe("unknown")
    expect(toWorkspaceApiError("boom").code).toBe("unknown")
  })

  test("an answer that arrives after another account signed in is dropped", async () => {
    workspaces.mine.mockImplementation(async () => {
      signIn("user_b")
      return {workspace: WORKSPACE}
    })
    expect(workspaceErrorCode(await cloudWorkspaceApi.mine().catch((error: unknown) => error))).toBe("session_changed")
  })

  test("a successful leave tells the reconciler; a reconciler that throws does not fail the leave", async () => {
    workspaces.leave.mockResolvedValue(undefined)
    jest.mocked(notifyFleetWorkspaceLeft).mockImplementationOnce(() => {
      throw new Error("reconciler gone")
    })
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})

    await expect(cloudWorkspaceApi.leave()).resolves.toBeUndefined()
    expect(workspaces.leave).toHaveBeenCalledWith({expectedAccount: "user_a"})
    expect(notifyFleetWorkspaceLeft).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  test("a leave names the workspace on screen, so Core never removes the person from another", async () => {
    workspaces.leave.mockResolvedValue(undefined)
    useMyWorkspaceStore.getState().set(WORKSPACE)
    await expect(cloudWorkspaceApi.leave()).resolves.toBeUndefined()
    expect(workspaces.leave).toHaveBeenCalledWith({expectedAccount: "user_a", workspaceId: "ws_1"})
  })

  test("refreshing desired state asks the reconciler and never throws", async () => {
    await expect(cloudWorkspaceApi.refreshDesiredState()).resolves.toBeUndefined()
    expect(triggerAssignmentReconcile).toHaveBeenCalledTimes(1)
  })
})

describe("installing the cloud workspace calls", () => {
  test("wires the calls once and forgets the workspace when someone else signs in", () => {
    const uninstall = installCloudWorkspaceApi()
    expect(installCloudWorkspaceApi()).toBe(uninstall)
    expect(getWorkspaceApi()).toBe(cloudWorkspaceApi)

    useMyWorkspaceStore.getState().set(WORKSPACE)
    signIn("user_a", "reconnect")
    expect(useMyWorkspaceStore.getState().workspace).toBe(WORKSPACE)

    signIn("user_b")
    expect(useMyWorkspaceStore.getState()).toMatchObject({workspace: null, loaded: false})

    useMyWorkspaceStore.getState().set(WORKSPACE)
    signIn(null, "signed_out")
    expect(useMyWorkspaceStore.getState().workspace).toBeNull()

    uninstall()
    expect(getWorkspaceApi()).not.toBe(cloudWorkspaceApi)
    expect(host.__listeners.size).toBe(0)
  })
})
