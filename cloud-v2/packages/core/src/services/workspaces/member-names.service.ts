/**
 * @fileoverview The names a member list shows beside its members.
 *
 * A person's name is the one their last sign-in through Core's provider carried (`signin_identities.name`),
 * the same row the admin license list reads an owner's name from (`licenses/license-list.service.ts`). Core's
 * `users` and `workspace_memberships` hold no name, only an opaque id and, on a membership, the email it was
 * made for. A person with no sign-in row (they have not signed in through the provider, or their account is
 * deleted, which deletes the row), or whose sign-in carried no name, has no entry here, and neither does a
 * membership imported from the Store that its person has not claimed yet: it has no Core user to look up.
 *
 * The names of a whole list are read in one query, however many members it has.
 */

import {SigninIdentityModel} from "../../models/signin-identity.model"

/**
 * The names of these people, by Core user id, from one `signin_identities` query. A person without a name
 * is absent; ids that are missing or repeated are skipped, and with nobody to name there is no query.
 */
export async function memberNames(
  mentraUserIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, string>> {
  const ids = [...new Set(mentraUserIds.filter((id): id is string => typeof id === "string" && id.length > 0))]
  if (ids.length === 0) return new Map()

  const identities = await SigninIdentityModel.find({mentraUserId: {$in: ids}}, {mentraUserId: 1, name: 1}).lean()
  const names = new Map<string, string>()
  for (const {mentraUserId, name} of identities) {
    // A sign-in that carried a blank name is the same as one that carried none.
    if (typeof name === "string" && name.trim().length > 0) names.set(mentraUserId, name)
  }
  return names
}
