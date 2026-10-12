/**
 * @fileoverview Verified Mentra account email for a user.
 *
 * Only first-party (`tenantId: "mentra"`) users store a GoTrue id in
 * `tenantUserId`. An OEM sub is a different identifier space, so a stray
 * collision would resolve some unrelated account's email; OEM users resolve to
 * null instead. Unverified addresses also resolve to null, so every caller can
 * treat a non-null result as an email the user has proven they own.
 */
import {UserModel} from "../../models/user.model"
import {getUserById} from "./gotrue.client"

const MENTRA_TENANT_ID = "mentra"

export async function trustedAccountEmail(
  mentraUserId: string,
  options: {signal?: AbortSignal} = {},
): Promise<string | null> {
  const user = await UserModel.findOne({mentraUserId}).lean()
  if (!user || user.tenantId !== MENTRA_TENANT_ID) return null
  // Deployments without an account directory (private clouds) have no
  // trusted email source.
  if (!process.env.SUPABASE_URL?.trim()) return null
  const identity = await getUserById(user.tenantUserId, options.signal)
  return identity?.emailVerified && identity.email ? identity.email : null
}
