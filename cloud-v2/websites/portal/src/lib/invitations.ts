/**
 * The invitations the portal offers the signed-in person, from two sources:
 *
 *  - the invitation link this tab holds (lib/workspace-invite), looked up by its token;
 *  - the invitations Core finds for the person's verified email (`GET /invitations/mine`), for someone
 *    who signs in without the link.
 *
 * Only valid ones are offered: a link Core says is no longer valid is forgotten and never counts. The
 * same invitation from both sources is offered once, as the link's. Invitations dismissed in this
 * browser are left out, unless the link was opened again.
 */

import type { InvitationPreview } from "@mentra/workspace-contract";
import { isInvitationForOtherAccount } from "@mentra/workspace-ui";

/** What the tab's invitation link is, once looked up. */
export type LinkInvitation =
  | { status: "none" }
  | { status: "checking"; token: string }
  | { status: "valid"; token: string; preview: InvitationPreview }
  /** It could not be looked up (a dropped connection, a 5xx): kept, and looked up again on the next visit. */
  | { status: "unavailable"; token: string; error: unknown; retry(): void }
  /** Core said it can never be accepted. Its token is already forgotten; this is shown once, on `/invitation`. */
  | { status: "gone" };

/** One invitation the person can act on. */
export interface PendingInvitation {
  preview: InvitationPreview;
  /** The token of this tab's link, when it came that way: accepted by it. Otherwise accepted by id. */
  token: string | null;
  /** Addressed to someone other than the signed-in person (only a link can be). */
  forOtherAccount: boolean;
}

/**
 * The invitations to offer, the link's first, then the person's own newest first. Undefined while either
 * source is still being looked up, so a screen never offers "Create your workspace" and then swaps it.
 */
export function pendingInvitations(args: {
  link: LinkInvitation;
  /** The person's invitations; null when they could not be listed (an unverified email): none. */
  mine: readonly InvitationPreview[] | null | undefined;
  dismissed: ReadonlySet<string>;
  accountEmail: string | null;
}): PendingInvitation[] | undefined {
  const { link, mine, dismissed, accountEmail } = args;
  if (link.status === "checking" || mine === undefined) return undefined;
  const result: PendingInvitation[] = [];
  const seen = new Set<string>();
  if (link.status === "valid") {
    result.push({
      preview: link.preview,
      token: link.token,
      forOtherAccount: isInvitationForOtherAccount(link.preview, accountEmail),
    });
    seen.add(link.preview.invitationId);
  }
  for (const preview of mine ?? []) {
    if (seen.has(preview.invitationId) || dismissed.has(preview.invitationId)) continue;
    seen.add(preview.invitationId);
    result.push({ preview, token: null, forOtherAccount: false });
  }
  return result;
}
