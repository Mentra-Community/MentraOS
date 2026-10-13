import { describe, expect, test } from "bun:test";
import type { AuditEventView } from "@mentra/workspace-contract";
import { actorLabel, describeAuditEvent, plainText, rawLines, readableChanges } from "./lib/audit";
import { formatDate } from "./lib/format";

const ALEX = { kind: "user" as const, email: "alex@acme.test", credentialId: null, service: null };

function event(action: string, fields: Partial<AuditEventView> = {}): AuditEventView {
  return {
    eventId: "evt_1",
    action,
    actor: ALEX,
    target: null,
    before: null,
    after: null,
    occurredAt: "2026-10-12T10:00:00.000Z",
    ...fields,
  };
}

const say = (e: AuditEventView) => plainText(describeAuditEvent(e).summary);
const notes = (e: AuditEventView) => describeAuditEvent(e).notes;

describe("audit events as sentences", () => {
  test("invitations name the invited address and the role, capitalised", () => {
    expect(
      say(
        event("invitation.created", {
          target: { invitationId: "winv_1", email: "jamie@acme.test" },
          after: { email: "jamie@acme.test", role: "member", expiresAt: "2026-10-26T01:31:56.560Z" },
        }),
      ),
    ).toBe("Invited jamie@acme.test as Member");
    expect(
      say(
        event("invitation.revoked", {
          target: { invitationId: "winv_1", email: "jamie@acme.test" },
          before: { status: "pending", role: "member" },
          after: { status: "revoked" },
        }),
      ),
    ).toBe("Revoked the invitation for jamie@acme.test (Member)");
    expect(
      say(
        event("invitation.revoked", {
          target: { invitationId: "winv_1", email: "jamie@acme.test" },
          before: { status: "pending", role: "developer" },
          after: { status: "revoked", reason: "superseded", supersededBy: "winv_2" },
        }),
      ),
    ).toBe("Replaced the invitation for jamie@acme.test (Developer) with a new one");
    expect(
      say(
        event("invitation.revoked", {
          target: { invitationId: "winv_1", email: "jamie@acme.test" },
          before: { status: "pending", role: "admin" },
          after: { status: "revoked", reason: "inviter_account_deleted" },
        }),
      ),
    ).toBe("Revoked the invitation for jamie@acme.test (Admin) because the inviter's account was deleted");
  });

  test("events recorded before Core named the subject still read sensibly", () => {
    expect(
      say(event("invitation.revoked", { target: { invitationId: "winv_1" }, before: { status: "pending", role: "member" }, after: { status: "revoked" } })),
    ).toBe("Revoked an invitation (Member)");
    expect(
      say(event("invitation.revoked", { target: { invitationId: "winv_1" }, before: { role: "member" }, after: { reason: "superseded" } })),
    ).toBe("Replaced an invitation (Member) with a new one");
    expect(
      say(event("membership.role_changed", { target: { membershipId: "wm_1", mentraUserId: "u_1" }, before: { role: "member" }, after: { role: "developer" } })),
    ).toBe("Changed a member from Member to Developer");
    expect(say(event("membership.removed", { target: { membershipId: "wm_1" }, before: { role: "developer", status: "active" } }))).toBe(
      "Removed a member (Developer)",
    );
    expect(say(event("membership.added", { target: { membershipId: "wm_1" }, after: { role: "member" } }))).toBe(
      "Joined the workspace as Member",
    );
    expect(say(event("invitation.accepted", { target: { invitationId: "winv_1", membershipId: "wm_1" } }))).toBe(
      "Accepted an invitation",
    );
    expect(say(event("membership.ownership_recovered", { target: { membershipId: "wm_1" }, before: { role: null }, after: { role: "owner" } }))).toBe(
      "Added a new Owner",
    );
    expect(say(event("credential.revoked", { target: { credentialId: "01ABC" } }))).toBe("Revoked a key");
    // Nothing at all recorded: still a sentence, never "undefined".
    for (const action of ["workspace.created", "workspace.renamed", "workspace.deleted", "invitation.created", "membership.left"]) {
      expect(say(event(action))).not.toContain("undefined");
      expect(say(event(action))).not.toContain("null");
    }
  });

  test("memberships: role changes, joining, leaving, removal and recovery", () => {
    expect(
      say(
        event("membership.role_changed", {
          target: { membershipId: "wm_1", mentraUserId: "u_1", email: "priya@acme.test" },
          before: { role: "member" },
          after: { role: "developer" },
        }),
      ),
    ).toBe("Changed priya@acme.test from Member to Developer");
    // Accepting an invitation records the new member as the actor.
    const joined = event("membership.added", {
      actor: { ...ALEX, email: "Jamie@Acme.test" },
      target: { membershipId: "wm_1", email: "jamie@acme.test" },
      before: { role: null },
      after: { role: "developer" },
    });
    expect(say(joined)).toBe("Joined the workspace as Developer");
    expect(say({ ...joined, actor: ALEX })).toBe("Added jamie@acme.test as Developer");

    const removed = event("membership.removed", {
      target: { membershipId: "wm_1", email: "dana@acme.test" },
      before: { role: "developer", status: "active" },
      after: { status: "ended", endedReason: "removed", revokedCredentialIds: ["01A", "01B"], revokedInvitationIds: ["winv_1"] },
    });
    expect(say(removed)).toBe("Removed dana@acme.test (Developer)");
    expect(notes(removed)).toEqual(["Their 2 keys and 1 pending invitation were revoked with it."]);
    expect(
      say({ ...removed, after: { status: "ended", endedReason: "account_deleted", revokedCredentialIds: [], revokedInvitationIds: [] } }),
    ).toBe("Removed dana@acme.test (Developer) because their account was deleted");
    expect(notes({ ...removed, after: { revokedCredentialIds: [], revokedInvitationIds: [] } })).toEqual([]);

    const left = event("membership.left", {
      target: { membershipId: "wm_1", email: "dana@acme.test" },
      before: { role: "admin", status: "active" },
      after: { status: "ended", revokedCredentialIds: ["01A"], revokedInvitationIds: [] },
    });
    expect(say(left)).toBe("Left the workspace (Admin)");
    expect(notes(left)).toEqual(["Their 1 key was revoked with it."]);

    expect(
      say(event("membership.ownership_recovered", { target: { membershipId: "wm_1", email: "heir@acme.test" }, before: { role: "member" }, after: { role: "owner" } })),
    ).toBe("Made heir@acme.test an Owner (was Member)");
  });

  test("the workspace and its keys", () => {
    expect(say(event("workspace.created", { target: { workspaceId: "ws_1", membershipId: "wm_1" }, after: { name: "Acme", role: "owner" } }))).toBe(
      "Created the workspace Acme",
    );
    expect(say(event("workspace.renamed", { before: { name: "A" }, after: { name: "B" } }))).toBe("Renamed the workspace from A to B");
    expect(say(event("workspace.deleted", { before: { name: "Acme", status: "active" }, after: { status: "deleted" } }))).toBe(
      "Deleted the workspace Acme",
    );
    const key = event("credential.created", {
      target: { credentialId: "01ABC", prefix: "msk", credentialKind: "workspace", workspaceId: "ws_1", name: "CI publisher" },
      after: { scopes: ["miniapps.publish"], packageNames: [], expiresAt: null, createdByMembershipId: "wm_1", issuedByService: null },
    });
    expect(say(key)).toBe("Created the key CI publisher (all packages)");
    expect(
      say({ ...key, after: { scopes: ["miniapps.publish"], packageNames: ["com.acme.a", "com.acme.b"], expiresAt: "2026-12-31T23:59:59.000Z" } }),
    ).toBe(`Created the key CI publisher (com.acme.a, com.acme.b, expires ${formatDate("2026-12-31T23:59:59.000Z")})`);
    expect(say(event("credential.revoked", { target: { credentialId: "01ABC", name: "CI publisher" }, before: { revokedAt: null } }))).toBe(
      "Revoked the key CI publisher",
    );
  });

  test("names are marked to stand out, and nothing internal shows in the sentence", () => {
    const { summary } = describeAuditEvent(
      event("membership.role_changed", {
        target: { membershipId: "wm_01SECRETLOOKING", mentraUserId: "mu_01X", email: "priya@acme.test" },
        before: { role: "member" },
        after: { role: "developer" },
      }),
    );
    expect(summary).toContainEqual({ strong: "priya@acme.test" });
    expect(summary).toContainEqual({ strong: "Developer" });
    expect(plainText(summary)).not.toContain("wm_");
    expect(plainText(summary)).not.toContain("mu_");
  });

  test("an action this UI does not know shows readable changes: ids hidden, dates formatted, lists as lists, no 'none →'", () => {
    const unknown = event("workspace.something_new", {
      before: { role: "member", tags: null, membershipId: "wm_1", same: "x" },
      after: { role: "admin", tags: ["a", "b"], membershipId: "wm_2", same: "x", expiresAt: "2026-10-26T01:31:56.560Z", gone: null },
    });
    expect(say(unknown)).toBe("workspace.something_new");
    const lines = notes(unknown);
    expect(lines).toContain("Role: Member → Admin");
    expect(lines).toContain("Tags: a, b");
    expect(lines.some((line) => line.startsWith("Expires at: ") && !line.includes("2026-10-26T"))).toBe(true);
    expect(lines.join("\n")).not.toContain("none");
    expect(lines.join("\n")).not.toContain("wm_");
    expect(lines.join("\n")).not.toContain("Same");
    expect(readableChanges({ before: { role: "member" }, after: { role: null } })).toEqual(["Role: Member (removed)"]);
  });

  test("the raw details keep everything as recorded", () => {
    expect(
      rawLines(
        event("invitation.revoked", {
          target: { invitationId: "winv_1", email: "jamie@acme.test" },
          before: { status: "pending", role: "member" },
          after: { status: "revoked" },
        }),
      ),
    ).toEqual(["invitationId: winv_1", "email: jamie@acme.test", "status: pending → revoked", "role: member → none"]);
  });
});

describe("who did it", () => {
  test("a person by email, a service on someone's behalf, the system", () => {
    expect(actorLabel(ALEX)).toBe("alex@acme.test");
    expect(actorLabel({ kind: "user", email: null, credentialId: null, service: null })).toBe("A user");
    expect(actorLabel({ kind: "service", email: "dana@acme.test", credentialId: null, service: "store" })).toBe(
      "Store service, for dana@acme.test",
    );
    expect(actorLabel({ kind: "service", email: null, credentialId: null, service: "store" })).toBe("Store service");
    expect(actorLabel({ kind: "credential", email: null, credentialId: "01ABC", service: null })).toBe("Key 01ABC");
    expect(actorLabel({ kind: "system", email: null, credentialId: null, service: null })).toBe("System");
  });
});
