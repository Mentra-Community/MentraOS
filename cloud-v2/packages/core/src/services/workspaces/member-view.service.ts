/**
 * @fileoverview Member rows as the API shows them, with the person's name.
 *
 * `MemberView.name` is the name Core last recorded for the person at sign-in (`signin_identities.name`: the Mentra
 * profile on hosted Core, the identity provider's `name` claim on a Private Cloud), so a changed name shows from
 * the person's next sign-in. A person Core has no name for (an imported membership still waiting for them, or
 * someone who never signed in through the provider) has `name: null`, and Fleet then shows their full email.
 */

import type {MemberView, WorkspaceRole} from "@mentra/workspace-contract"
import {memberNames} from "./member-names.service"
import type {MembershipRow} from "./workspace.service"

/** `rows` as `MemberView`s, in order, each with its person's name or null. */
export async function toMemberViews(rows: MembershipRow[]): Promise<MemberView[]> {
  const names = await memberNames(rows.map(row => row.mentraUserId))
  return rows.map(row => ({
    membershipId: row.membershipId,
    mentraUserId: row.mentraUserId ?? null,
    email: row.email ?? null,
    name: row.mentraUserId ? (names.get(row.mentraUserId) ?? null) : null,
    role: row.role as WorkspaceRole,
    startedAt: row.startedAt.toISOString(),
    // Imported from the Store and not yet claimed: the person has no Core user here until they sign in.
    pending: !row.mentraUserId,
  }))
}
