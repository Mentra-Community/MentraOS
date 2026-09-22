import {afterEach, beforeEach, describe, expect, mock, test} from "bun:test"

import {configure, resetForTests} from "../../runtime/bootstrap"
import {cloudClientService} from "./cloudClientServiceTestMock"

let privateMeetings = true
let enabled = true
let auth: {getTeamsToken?: () => Promise<string>}
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
const {meetingCredential, meetingConfiguration} = await import("../MeetingCredentials")

beforeEach(() => {
  privateMeetings = true
  enabled = true
  resetForTests()
  setAuth({})
  getMeetingCredential.mockClear()
  getMeetingCredential.mockImplementation(async () => ({
    token: "acs",
    expiresOn: "2030-01-01",
    identityMode: "guest",
    acsUserId: "guest",
    guestReason: undefined,
  }))
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
