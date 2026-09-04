import { afterEach, describe, expect, test } from "bun:test";

import {
  mintAcsGuestToken,
  resetAcsTeamsAuthCache,
  setAcsIdentityClientForTests,
  validateTeamsSubjectClaims,
  type AcsIdentityClient,
} from "./acs-teams.service";

const configuration = { tenantId: "tenant-1", clientId: "mobile-client" };
const expected = { tenantId: "tenant-1", objectId: "employee-1" };

function payload(overrides: Record<string, unknown> = {}) {
  return {
    tid: "tenant-1",
    oid: "employee-1",
    azp: "mobile-client",
    scp: "Teams.ManageCalls Teams.ManageChats",
    ...overrides,
  };
}

describe("ACS Teams subject validation", () => {
  test("accepts the same Entra employee with both delegated Teams permissions", () => {
    expect(() =>
      validateTeamsSubjectClaims(payload(), expected, configuration),
    ).not.toThrow();
  });

  test("rejects cross-user, cross-client, and incomplete delegated tokens", () => {
    expect(() =>
      validateTeamsSubjectClaims(
        payload({ oid: "other-employee" }),
        expected,
        configuration,
      ),
    ).toThrow();
    expect(() =>
      validateTeamsSubjectClaims(
        payload({ azp: "other-client" }),
        expected,
        configuration,
      ),
    ).toThrow();
    expect(() =>
      validateTeamsSubjectClaims(
        payload({ scp: "Teams.ManageCalls" }),
        expected,
        configuration,
      ),
    ).toThrow();
  });
});

describe("ACS guest credentials", () => {
  const previousConnectionString = process.env.ACS_CONNECTION_STRING;

  afterEach(() => {
    resetAcsTeamsAuthCache();
    if (previousConnectionString === undefined)
      delete process.env.ACS_CONNECTION_STRING;
    else process.env.ACS_CONNECTION_STRING = previousConnectionString;
  });

  test("creates one guest identity and reuses its fresh token for the authenticated user", async () => {
    process.env.ACS_CONNECTION_STRING =
      "endpoint=https://test.communication.azure.com/;accesskey=test";
    let creates = 0;
    setAcsIdentityClientForTests({
      async createUserAndToken(scopes, options) {
        creates += 1;
        expect(scopes).toEqual(["voip"]);
        expect(options.tokenExpiresInMinutes).toBe(120);
        return {
          token: "guest-token",
          expiresOn: new Date(Date.now() + 60 * 60 * 1000),
          user: { communicationUserId: "guest-user" },
        };
      },
      async getTokenForTeamsUser() {
        throw new Error("not used");
      },
    } satisfies AcsIdentityClient);

    const first = await mintAcsGuestToken("tenant:user");
    const second = await mintAcsGuestToken("tenant:user");

    expect(first).toEqual({
      token: "guest-token",
      expiresOn: first.expiresOn,
      identityMode: "guest",
      acsUserId: "guest-user",
    });
    expect(second).toEqual(first);
    expect(creates).toBe(1);
  });

  test("limits repeated guest-token mints for one authenticated user", async () => {
    process.env.ACS_CONNECTION_STRING =
      "endpoint=https://test.communication.azure.com/;accesskey=test";
    let tokenNumber = 0;
    const expiredCredential = () => ({
      token: `guest-token-${++tokenNumber}`,
      expiresOn: new Date(0),
    });
    setAcsIdentityClientForTests({
      async createUserAndToken() {
        return {
          ...expiredCredential(),
          user: { communicationUserId: "guest-user" },
        };
      },
      async getToken() {
        return expiredCredential();
      },
      async getTokenForTeamsUser() {
        throw new Error("not used");
      },
    } satisfies AcsIdentityClient);

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await mintAcsGuestToken("tenant:rate-limited-user");
    }
    await expect(
      mintAcsGuestToken("tenant:rate-limited-user"),
    ).rejects.toMatchObject({ status: 429 });
  });
});
