import {afterEach, describe, expect, test} from "bun:test"

import {
  ACS_GUEST_STATE_MAX_ENTRIES,
  getAcsGuestStateSizeForTests,
  mintAcsGuestToken,
  resetAcsTeamsAuthCache,
  setAcsIdentityClientForTests,
  validateTeamsSubjectClaims,
  type AcsIdentityClient,
} from "./acs-teams.service"

const configuration = {tenantId: "tenant-1", clientId: "mobile-client"}
const expected = {tenantId: "tenant-1", objectId: "employee-1"}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    tid: "tenant-1",
    oid: "employee-1",
    azp: "mobile-client",
    scp: "Teams.ManageCalls Teams.ManageChats",
    ...overrides,
  }
}

describe("ACS Teams subject validation", () => {
  test("accepts the same Entra employee with both delegated Teams permissions", () => {
    expect(() => validateTeamsSubjectClaims(payload(), expected, configuration)).not.toThrow()
  })

  test("rejects cross-user, cross-client, and incomplete delegated tokens", () => {
    expect(() => validateTeamsSubjectClaims(payload({oid: "other-employee"}), expected, configuration)).toThrow()
    expect(() => validateTeamsSubjectClaims(payload({azp: "other-client"}), expected, configuration)).toThrow()
    expect(() => validateTeamsSubjectClaims(payload({scp: "Teams.ManageCalls"}), expected, configuration)).toThrow()
  })
})

describe("ACS guest credentials", () => {
  const previousConnectionString = process.env.ACS_CONNECTION_STRING

  afterEach(() => {
    resetAcsTeamsAuthCache()
    if (previousConnectionString === undefined) delete process.env.ACS_CONNECTION_STRING
    else process.env.ACS_CONNECTION_STRING = previousConnectionString
  })

  test("creates one guest identity and reuses its fresh token for the authenticated user", async () => {
    process.env.ACS_CONNECTION_STRING = "endpoint=https://test.communication.azure.com/;accesskey=test"
    let creates = 0
    const expiresOn = new Date(Date.now() + 60 * 60 * 1000)
    setAcsIdentityClientForTests({
      async createUserAndToken(scopes, options) {
        creates += 1
        expect(scopes).toEqual(["voip"])
        expect(options.tokenExpiresInMinutes).toBe(120)
        return {
          token: "guest-token",
          expiresOn,
          user: {communicationUserId: "guest-user"},
        }
      },
      async getTokenForTeamsUser() {
        throw new Error("not used")
      },
    } satisfies AcsIdentityClient)

    const first = await mintAcsGuestToken("tenant:user")
    const second = await mintAcsGuestToken("tenant:user")

    expect(first).toEqual({
      token: "guest-token",
      expiresOn: expiresOn.toISOString(),
      identityMode: "guest",
      acsUserId: "guest-user",
    })
    expect(second).toEqual(first)
    expect(creates).toBe(1)
  })

  test("shares one ACS request across concurrent guest-token callers", async () => {
    process.env.ACS_CONNECTION_STRING = "endpoint=https://test.communication.azure.com/;accesskey=test"
    let creates = 0
    let releaseCreate: (() => void) | undefined
    const createMayFinish = new Promise<void>((resolve) => {
      releaseCreate = resolve
    })
    setAcsIdentityClientForTests({
      async createUserAndToken() {
        creates += 1
        await createMayFinish
        return {
          token: "shared-token",
          expiresOn: new Date(Date.now() + 60 * 60 * 1000),
          user: {communicationUserId: "shared-user"},
        }
      },
      async getTokenForTeamsUser() {
        throw new Error("not used")
      },
    } satisfies AcsIdentityClient)

    const requests = Array.from({length: 20}, () => mintAcsGuestToken("tenant:concurrent-user"))
    await Promise.resolve()
    expect(creates).toBe(1)
    releaseCreate?.()

    const credentials = await Promise.all(requests)
    expect(new Set(credentials.map(({token}) => token))).toEqual(new Set(["shared-token"]))
    expect(creates).toBe(1)
  })

  test("preserves an existing ACS identity across transient refresh failures", async () => {
    process.env.ACS_CONNECTION_STRING = "endpoint=https://test.communication.azure.com/;accesskey=test"
    let creates = 0
    let refreshes = 0
    setAcsIdentityClientForTests({
      async createUserAndToken() {
        creates += 1
        return {
          token: "expired-token",
          expiresOn: new Date(0),
          user: {communicationUserId: "stable-user"},
        }
      },
      async getToken(user) {
        expect(user.communicationUserId).toBe("stable-user")
        refreshes += 1
        if (refreshes === 1) throw new Error("temporary network failure")
        return {
          token: "refreshed-token",
          expiresOn: new Date(Date.now() + 60 * 60 * 1000),
        }
      },
      async getTokenForTeamsUser() {
        throw new Error("not used")
      },
    } satisfies AcsIdentityClient)

    await mintAcsGuestToken("tenant:stable-user")
    await expect(mintAcsGuestToken("tenant:stable-user")).rejects.toMatchObject({status: 502})
    const refreshed = await mintAcsGuestToken("tenant:stable-user")

    expect(refreshed).toMatchObject({
      token: "refreshed-token",
      acsUserId: "stable-user",
    })
    expect(creates).toBe(1)
    expect(refreshes).toBe(2)
  })

  test("limits repeated guest-token mints for one authenticated user", async () => {
    process.env.ACS_CONNECTION_STRING = "endpoint=https://test.communication.azure.com/;accesskey=test"
    let tokenNumber = 0
    const expiredCredential = () => ({
      token: `guest-token-${++tokenNumber}`,
      expiresOn: new Date(0),
    })
    setAcsIdentityClientForTests({
      async createUserAndToken() {
        return {
          ...expiredCredential(),
          user: {communicationUserId: "guest-user"},
        }
      },
      async getToken() {
        return expiredCredential()
      },
      async getTokenForTeamsUser() {
        throw new Error("not used")
      },
    } satisfies AcsIdentityClient)

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await mintAcsGuestToken("tenant:rate-limited-user")
    }
    await expect(mintAcsGuestToken("tenant:rate-limited-user")).rejects.toMatchObject({status: 429})
  })

  test("bounds guest identity state across authenticated users", async () => {
    process.env.ACS_CONNECTION_STRING = "endpoint=https://test.communication.azure.com/;accesskey=test"
    setAcsIdentityClientForTests({
      async createUserAndToken() {
        return {
          token: "guest-token",
          expiresOn: new Date(Date.now() + 60 * 60 * 1000),
          user: {communicationUserId: "guest-user"},
        }
      },
      async getTokenForTeamsUser() {
        throw new Error("not used")
      },
    } satisfies AcsIdentityClient)

    for (let userNumber = 0; userNumber < ACS_GUEST_STATE_MAX_ENTRIES + 2; userNumber += 1) {
      await mintAcsGuestToken(`tenant:user-${userNumber}`)
    }

    expect(getAcsGuestStateSizeForTests()).toBe(ACS_GUEST_STATE_MAX_ENTRIES)
  })
})
