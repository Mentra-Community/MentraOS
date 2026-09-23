import {afterEach, beforeEach, describe, expect, test} from "bun:test"
import {issueAcsTeamsCredential, resetAcsTeamsAuthCache, setAcsIdentityClientForTests} from "./acs-teams.service"

const subject = {token: "verified-subject", tenantId: "tenant", objectId: "employee"}
const saved = {
  connection: process.env.ACS_CONNECTION_STRING,
  tenant: process.env.ENTRA_TENANT_ID,
  client: process.env.ENTRA_CLIENT_ID,
}
let exchangeError: unknown
let guestMints = 0

beforeEach(() => {
  process.env.ACS_CONNECTION_STRING = "endpoint=https://test.communication.azure.com/;accesskey=test"
  process.env.ENTRA_TENANT_ID = "tenant"
  process.env.ENTRA_CLIENT_ID = "mobile-client"
  guestMints = 0
  exchangeError = undefined
  setAcsIdentityClientForTests({
    async getTokenForTeamsUser(input) {
      expect(input).toEqual({teamsUserAadToken: subject.token, clientId: "mobile-client", userObjectId: "employee"})
      if (exchangeError) throw exchangeError
      return {token: "employee-token", expiresOn: new Date("2030-01-01")}
    },
    async createUserAndToken() {
      guestMints++
      return {token: "guest-token", expiresOn: new Date("2030-01-01"), user: {communicationUserId: "acs-guest"}}
    },
  })
})
afterEach(() => {
  resetAcsTeamsAuthCache()
  for (const [key, value] of Object.entries({
    ACS_CONNECTION_STRING: saved.connection,
    ENTRA_TENANT_ID: saved.tenant,
    ENTRA_CLIENT_ID: saved.client,
  })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe("Teams identity selection", () => {
  test("uses the licensed employee identity", async () => {
    expect(await issueAcsTeamsCredential(subject, "user")).toMatchObject({
      token: "employee-token",
      identityMode: "teams-user",
    })
    expect(guestMints).toBe(0)
  })
  test("automatically joins as a guest only for Microsoft's missing-license code", async () => {
    exchangeError = Object.assign(new Error("Teams disabled in user licenses"), {
      code: "UserLicenseNotPresentForbidden",
    })
    expect(await issueAcsTeamsCredential(subject, "user")).toMatchObject({
      identityMode: "guest",
      guestReason: "teams-license-unavailable",
    })
    expect(guestMints).toBe(1)
  })
  for (const error of [
    {code: "Forbidden"},
    {code: "Unauthorized"},
    {code: "TooManyRequests"},
    new Error("UserLicenseNotPresentForbidden"),
    new Error("network unavailable"),
  ])
    test(`does not downgrade ${JSON.stringify(error)}`, async () => {
      exchangeError = error
      await expect(issueAcsTeamsCredential(subject, "user")).rejects.toBe(error)
      expect(guestMints).toBe(0)
    })
})
