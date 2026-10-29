import { describe, expect, test } from "bun:test";
import type { InvitationPreview } from "@mentra/workspace-contract";
import { pendingInvitations, type LinkInvitation } from "./invitations";

function preview(id: string, fields: Partial<InvitationPreview> = {}): InvitationPreview {
  return {
    invitationId: id,
    workspaceId: `ws_${id}`,
    workspaceName: `Workspace ${id}`,
    email: "sam@acme.test",
    role: "member",
    invitedByEmail: "olivia@acme.test",
    expiresAt: "2026-10-26T01:25:48.000Z",
    ...fields,
  };
}

const none: LinkInvitation = { status: "none" };
const ids = (list: ReturnType<typeof pendingInvitations>) => list?.map(item => item.preview.invitationId);

describe("the invitations the portal offers", () => {
  test("nothing is decided while either source is still being looked up", () => {
    expect(pendingInvitations({ link: { status: "checking", token: "t" }, mine: [], dismissed: new Set(), accountEmail: null })).toBeUndefined();
    expect(pendingInvitations({ link: none, mine: undefined, dismissed: new Set(), accountEmail: null })).toBeUndefined();
  });

  test("the link's invitation first, then the person's own; the same invitation once, as the link's", () => {
    const link: LinkInvitation = { status: "valid", token: "tok", preview: preview("b") };
    const list = pendingInvitations({ link, mine: [preview("a"), preview("b"), preview("c")], dismissed: new Set(), accountEmail: "sam@acme.test" });
    expect(ids(list)).toEqual(["b", "a", "c"]);
    expect(list![0]!.token).toBe("tok");
    expect(list!.slice(1).every(item => item.token === null)).toBe(true);
  });

  test("a link that is no longer valid, unavailable, or absent never counts", () => {
    for (const link of [{ status: "gone" }, none, { status: "unavailable", token: "t", error: new Error("x"), retry() {} }] as LinkInvitation[]) {
      expect(pendingInvitations({ link, mine: [], dismissed: new Set(), accountEmail: null })).toEqual([]);
    }
  });

  test("dismissed invitations are left out, unless their link was opened again", () => {
    const link: LinkInvitation = { status: "valid", token: "tok", preview: preview("b") };
    expect(ids(pendingInvitations({ link: none, mine: [preview("a"), preview("b")], dismissed: new Set(["a"]), accountEmail: null }))).toEqual(["b"]);
    expect(ids(pendingInvitations({ link, mine: [preview("b")], dismissed: new Set(["b"]), accountEmail: null }))).toEqual(["b"]);
  });

  test("an unlistable set (an unverified email) is none; a link for someone else is marked", () => {
    expect(pendingInvitations({ link: none, mine: null, dismissed: new Set(), accountEmail: null })).toEqual([]);
    const link: LinkInvitation = { status: "valid", token: "tok", preview: preview("b", { email: "B@Else.test" }) };
    expect(pendingInvitations({ link, mine: null, dismissed: new Set(), accountEmail: "sam@acme.test" })![0]!.forOtherAccount).toBe(true);
    expect(pendingInvitations({ link, mine: null, dismissed: new Set(), accountEmail: " b@else.TEST " })![0]!.forOtherAccount).toBe(false);
  });
});
