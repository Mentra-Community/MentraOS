import {afterEach, beforeEach, describe, expect, mock, test} from "bun:test"

import {configure, resetForTests} from "../../runtime/bootstrap"
import {cloudClientService} from "./cloudClientServiceTestMock"

let privateMeetings = true
let enabled = true
let auth: {
  getTeamsToken?: () => Promise<string>
  getMeetingAccount?: () => Promise<{displayName?: string; email?: string}>
}
const getMeetingCredential = mock(async (_token?: string) => ({
  token: "acs",
  expiresOn: "2030-01-01",
  identityMode: "guest" as "guest" | "teams-user",
  acsUserId: "guest",
  guestReason: undefined as "teams-license-unavailable" | undefined,
}))
cloudClientService.getMeetingCredential = getMeetingCredential
function setAuth(next: typeof auth): void {
  auth = next
  configure({auth, config: {privateMeetings, features: {nativeMeetings: enabled}}})
}
const createTeamsMeeting = mock(async (_options: unknown, _token?: string) => ({
  provider: "acs-teams",
  joinUrl: "https://teams.microsoft.com/meet/123456",
  meetingRef: "ownership",
  identityMode: "guest",
  guestReason: "no-entra-identity",
}))
const retireTeamsMeeting = mock(async (_ref: string) => {})
cloudClientService.createTeamsMeeting = createTeamsMeeting
cloudClientService.retireTeamsMeeting = retireTeamsMeeting
const {createMeeting, retireMeeting, meetingCredential, meetingConfiguration, meetingIdentity} = await import(
  "../MeetingCredentials"
)

beforeEach(() => {
  privateMeetings = true
  enabled = true
  resetForTests()
  setAuth({})
  getMeetingCredential.mockClear()
  createTeamsMeeting.mockClear()
  createTeamsMeeting.mockImplementation(async () => ({
    provider: "acs-teams",
    joinUrl: "https://teams.microsoft.com/meet/123456",
    meetingRef: "ownership",
    identityMode: "guest",
    guestReason: "no-entra-identity",
  }))
  retireTeamsMeeting.mockClear()
  getMeetingCredential.mockImplementation(async () => ({
    token: "acs",
    expiresOn: "2030-01-01",
    identityMode: "guest",
    acsUserId: "guest",
    guestReason: undefined,
  }))
})

describe("host-owned meeting creation", () => {
  const options = {provider: "acs-teams" as const, subject: "Standup", durationMinutes: 30}
  test("forwards the host's employee token to Runtime, not to the miniapp result", async () => {
    setAuth({getTeamsToken: async () => "host-token"})
    const result = await createMeeting(options)
    expect(createTeamsMeeting).toHaveBeenCalledWith({subject: "Standup", durationMinutes: 30}, "host-token")
    expect(result).not.toHaveProperty("token")
    expect(meetingConfiguration().creationSource).toBe("runtime")
  })
  test("allows the Runtime fallback organizer when there is no Entra identity", async () => {
    expect(await createMeeting(options)).toMatchObject({identityMode: "guest", guestReason: "no-entra-identity"})
    expect(createTeamsMeeting).toHaveBeenCalledWith({subject: "Standup", durationMinutes: 30}, undefined)
  })
  test("does not downgrade a failed identity acquisition", async () => {
    setAuth({
      getTeamsToken: async () => {
        throw new Error("Consent required")
      },
    })
    await expect(createMeeting(options)).rejects.toThrow("Consent required")
    expect(createTeamsMeeting).not.toHaveBeenCalled()
  })
  test("does not send an old workspace's token after an authentication change", async () => {
    setAuth({
      getTeamsToken: async () => {
        setAuth({})
        return "old-token"
      },
    })
    await expect(createMeeting(options)).rejects.toThrow("Deployment changed")
    expect(createTeamsMeeting).not.toHaveBeenCalled()
  })
  test("rejects a creation result after a workspace switch", async () => {
    createTeamsMeeting.mockImplementation(async () => {
      setAuth({})
      return {
        provider: "acs-teams",
        joinUrl: "https://teams.microsoft.com/meet/123456",
        meetingRef: "old-ref",
        identityMode: "guest",
        guestReason: "no-entra-identity",
      }
    })
    await expect(createMeeting(options)).rejects.toThrow("Deployment changed")
  })
  test("keeps consumer creation on its existing backend", async () => {
    privateMeetings = false
    setAuth({})
    expect(meetingConfiguration().creationSource).toBe("miniapp")
    await expect(createMeeting(options)).rejects.toThrow("miniapp-owned")
    await expect(retireMeeting("reference")).rejects.toThrow("miniapp-owned")
    expect(createTeamsMeeting).not.toHaveBeenCalled()
    expect(retireTeamsMeeting).not.toHaveBeenCalled()
  })
  test("enforces the deployment feature before creating or retiring", async () => {
    enabled = false
    setAuth({})
    await expect(createMeeting(options)).rejects.toThrow("disabled")
    await expect(retireMeeting("reference")).rejects.toThrow("disabled")
  })
  test("validates untrusted RPC arguments before sending any request", async () => {
    for (const invalid of [{provider: "unknown"}, {...options, durationMinutes: -1}, {...options, subject: 10}]) {
      await expect(createMeeting(invalid as never)).rejects.toThrow("Invalid")
    }
    await expect(retireMeeting(10 as never)).rejects.toThrow("Invalid")
    expect(createTeamsMeeting).not.toHaveBeenCalled()
    expect(retireTeamsMeeting).not.toHaveBeenCalled()
  })
  test("forwards only the ownership receipt when retiring", async () => {
    await retireMeeting("owned-reference")
    expect(retireTeamsMeeting).toHaveBeenCalledWith("owned-reference")
  })
})
afterEach(() => resetForTests())

describe("host-owned meeting credentials", () => {
  test("a private deployment rejects public backend and stream routing", () => {
    expect(meetingConfiguration()).toMatchObject({credentialSource: "runtime", externalBackendAllowed: false})
  })
  test("without Entra, mints a guest on the selected Runtime and ignores a supplied miniapp token", async () => {
    expect(await meetingCredential("untrusted-miniapp-token")).toMatchObject({
      token: "acs",
      identityMode: "guest",
      guestReason: "no-entra-identity",
    })
    expect(getMeetingCredential).toHaveBeenCalledWith(undefined)
  })
  test("passes the host's Entra token and reports the employee identity", async () => {
    setAuth({getTeamsToken: async () => "entra-subject"})
    getMeetingCredential.mockImplementation(async () => ({
      token: "acs-teams",
      expiresOn: "2030-01-01",
      identityMode: "teams-user",
      acsUserId: "",
      guestReason: undefined,
    }))
    expect(await meetingCredential()).toMatchObject({token: "acs-teams", identityMode: "teams-user"})
    expect(getMeetingCredential).toHaveBeenCalledWith("entra-subject")
  })
  test("exposes the missing-license guest reason", async () => {
    setAuth({getTeamsToken: async () => "entra-subject"})
    getMeetingCredential.mockImplementation(async () => ({
      token: "acs",
      expiresOn: "2030-01-01",
      identityMode: "guest",
      acsUserId: "guest",
      guestReason: "teams-license-unavailable",
    }))
    expect(await meetingCredential()).toMatchObject({identityMode: "guest", guestReason: "teams-license-unavailable"})
  })
  test("does not silently downgrade a failed Entra acquisition", async () => {
    setAuth({
      getTeamsToken: async () => {
        throw new Error("Consent required")
      },
    })
    await expect(meetingCredential()).rejects.toThrow("Consent required")
    expect(getMeetingCredential).not.toHaveBeenCalled()
  })
  test("disabled native meetings cannot be bypassed by supplying a credential", async () => {
    enabled = false
    setAuth(auth)
    await expect(meetingCredential("legacy")).rejects.toThrow("disabled")
    expect(getMeetingCredential).not.toHaveBeenCalled()
  })
  test("preserves legacy consumer clients without requiring Runtime meetings", async () => {
    privateMeetings = false
    setAuth(auth)
    expect(await meetingCredential("legacy")).toMatchObject({
      token: "legacy",
      identityMode: "guest",
      guestReason: "legacy-credential",
    })
    expect(getMeetingCredential).not.toHaveBeenCalled()
  })
  for (const token of [undefined, "", "   "])
    test("consumer calls require the legacy credential", async () => {
      privateMeetings = false
      setAuth(auth)
      await expect(meetingCredential(token)).rejects.toThrow("miniapp-supplied")
      expect(getMeetingCredential).not.toHaveBeenCalled()
    })
  for (const reuseAuth of [false, true])
    test(`does not send an old workspace's subject after switching (reuse auth: ${reuseAuth})`, async () => {
      setAuth({
        getTeamsToken: async () => {
          setAuth(reuseAuth ? auth : {})
          return "old-workspace-subject"
        },
      })
      await expect(meetingCredential()).rejects.toThrow("Deployment changed")
      expect(getMeetingCredential).not.toHaveBeenCalled()
    })
  test("a deployment switch invalidates an in-flight exchange", async () => {
    getMeetingCredential.mockImplementation(async () => {
      setAuth({})
      return {token: "acs", expiresOn: "2030-01-01", identityMode: "guest", acsUserId: "guest", guestReason: undefined}
    })
    await expect(meetingCredential()).rejects.toThrow("Deployment changed")
  })
})

describe("meeting identity preflight", () => {
  test("returns only public identity and the selected Entra profile", async () => {
    setAuth({
      getTeamsToken: async () => "host-secret",
      getMeetingAccount: async () => ({displayName: "Alex", email: "alex@example.com"}),
    })
    getMeetingCredential.mockImplementation(async () => ({
      token: "acs-secret",
      expiresOn: "2030-01-01",
      identityMode: "teams-user",
      acsUserId: "",
      guestReason: undefined,
    }))
    expect(await meetingIdentity()).toEqual({
      identityMode: "teams-user",
      account: {displayName: "Alex", email: "alex@example.com"},
    })
    expect(createTeamsMeeting).not.toHaveBeenCalled()
  })
  test("distinguishes no Entra identity and an unlicensed Entra account", async () => {
    expect(await meetingIdentity()).toEqual({identityMode: "guest", guestReason: "no-entra-identity"})
    setAuth({getTeamsToken: async () => "host-secret", getMeetingAccount: async () => ({email: "alex@example.com"})})
    getMeetingCredential.mockImplementation(async () => ({
      token: "acs-secret",
      expiresOn: "2030-01-01",
      identityMode: "guest",
      acsUserId: "guest",
      guestReason: "teams-license-unavailable",
    }))
    expect(await meetingIdentity()).toEqual({
      identityMode: "guest",
      guestReason: "teams-license-unavailable",
      account: {displayName: undefined, email: "alex@example.com"},
    })
  })
  test("consumer identity checks need no provider token", async () => {
    privateMeetings = false
    setAuth({})
    expect(await meetingIdentity()).toEqual({identityMode: "guest", guestReason: "legacy-credential"})
    expect(getMeetingCredential).not.toHaveBeenCalled()
  })
  test("does not report guest when identity acquisition fails", async () => {
    setAuth({
      getTeamsToken: async () => {
        throw new Error("Consent required")
      },
    })
    await expect(meetingIdentity()).rejects.toThrow("Consent required")
  })
  test("rejects an account lookup that outlives its workspace", async () => {
    setAuth({
      getMeetingAccount: async () => {
        setAuth({})
        return {email: "old@example.com"}
      },
    })
    await expect(meetingIdentity()).rejects.toThrow("Deployment changed")
    expect(getMeetingCredential).not.toHaveBeenCalled()
  })
})
