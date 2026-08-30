import { describe, expect, test } from "bun:test";

import { validateTeamsSubjectClaims } from "./acs-teams.service";

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
