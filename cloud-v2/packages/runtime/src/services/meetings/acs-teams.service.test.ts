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
    for (let attempt = 0; attempt < 10 && creates === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
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
        if (refreshes === 1) throw {status: 401, code: "Denied"}
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

  test("replaces an ACS identity after IdentityNotFound from the provider", async () => {
    process.env.ACS_CONNECTION_STRING = "endpoint=https://test.communication.azure.com/;accesskey=test"
    let creates = 0
    setAcsIdentityClientForTests({
      async createUserAndToken() {
        creates += 1
        return {
          token: `guest-token-${creates}`,
          expiresOn: creates === 1 ? new Date(0) : new Date(Date.now() + 60 * 60 * 1000),
          user: {communicationUserId: `guest-user-${creates}`},
        }
      },
      async getToken() {
        throw {status: 401, code: "IdentityNotFound"}
      },
      async getTokenForTeamsUser() {
        throw new Error("not used")
      },
    } satisfies AcsIdentityClient)

    await mintAcsGuestToken("tenant:missing-user")
    await expect(mintAcsGuestToken("tenant:missing-user")).rejects.toMatchObject({status: 502})
    const replacement = await mintAcsGuestToken("tenant:missing-user")

    expect(replacement.acsUserId).toBe("guest-user-2")
    expect(creates).toBe(2)
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

  test("bounds guest identity state without evicting live ACS identities", async () => {
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
      if (userNumber < ACS_GUEST_STATE_MAX_ENTRIES) {
        await mintAcsGuestToken(`tenant:user-${userNumber}`)
      } else {
        await expect(mintAcsGuestToken(`tenant:user-${userNumber}`)).rejects.toMatchObject({status: 503})
      }
    }

    expect(getAcsGuestStateSizeForTests()).toBe(ACS_GUEST_STATE_MAX_ENTRIES)
  })

  test("deletes an expired idle ACS identity before evicting its state", async () => {
    process.env.ACS_CONNECTION_STRING = "endpoint=https://test.communication.azure.com/;accesskey=test"
    const originalNow = Date.now
    const deletedUsers: string[] = []
    let now = 1_000_000
    Date.now = () => now
    try {
      setAcsIdentityClientForTests({
        async createUserAndToken() {
          return {
            token: "guest-token",
            expiresOn: new Date(now + 60 * 60 * 1000),
            user: {communicationUserId: "guest-user"},
          }
        },
        async deleteUser(user) {
          deletedUsers.push(user.communicationUserId)
        },
        async getTokenForTeamsUser() {
          throw new Error("not used")
        },
      } satisfies AcsIdentityClient)

      await mintAcsGuestToken("tenant:idle-user")
      now += 4 * 60 * 60 * 1000 + 1
      await mintAcsGuestToken("tenant:new-user")

      expect(deletedUsers).toEqual(["guest-user"])
      expect(getAcsGuestStateSizeForTests()).toBe(1)
    } finally {
      Date.now = originalNow
    }
  })

  test("does not block unrelated issuance or delete a returning user's active identity", async () => {
    process.env.ACS_CONNECTION_STRING = "endpoint=https://test.communication.azure.com/;accesskey=test"
    const originalNow = Date.now
    let now = 1_000_000
    let creates = 0
    let releaseDeletion: (() => void) | undefined
    const deletionMayFinish = new Promise<void>((resolve) => {
      releaseDeletion = resolve
    })
    Date.now = () => now
    try {
      setAcsIdentityClientForTests({
        async createUserAndToken() {
          creates += 1
          return {
            token: `guest-token-${creates}`,
            expiresOn: new Date(now + 60 * 60 * 1000),
            user: {communicationUserId: `guest-user-${creates}`},
          }
        },
        async deleteUser() {
          await deletionMayFinish
        },
        async getToken() {
          throw new Error("cleanup must finish before a returning user mints")
        },
        async getTokenForTeamsUser() {
          throw new Error("not used")
        },
      } satisfies AcsIdentityClient)

      await mintAcsGuestToken("tenant:idle-user")
      now += 4 * 60 * 60 * 1000 + 1

      const unrelated = await mintAcsGuestToken("tenant:new-user")
      expect(unrelated.acsUserId).toBe("guest-user-2")

      let returningFinished = false
      const returning = mintAcsGuestToken("tenant:idle-user").then((credential) => {
        returningFinished = true
        return credential
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(returningFinished).toBe(false)

      releaseDeletion?.()
      expect((await returning).acsUserId).toBe("guest-user-3")
    } finally {
      Date.now = originalNow
    }
  })
})
