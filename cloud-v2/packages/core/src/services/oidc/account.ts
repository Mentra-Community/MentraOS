/**
 * @fileoverview The person behind a provider session or token.
 *
 * Core's sign-in server, its access tokens and its userinfo accept a person
 * only while Core still does: the account exists and is not deleted, the
 * sign-in (or token) is not from before their `webSignInsRevokedAt`, and the
 * sign-in source they used is still configured.
 */

import {SigninIdentityModel} from "../../models/signin-identity.model"
import {UserModel} from "../../models/user.model"
import {isSourceEnabled} from "../signin/config"
import {isDeletedAccount} from "../user.service"

/**
 * Whether a sign-in or token at `authTimeSec` (whole seconds, as tokens carry
 * it) came before the person's revocation. Read strictly: anything from the
 * revocation's own second is treated as before it.
 */
export function signedInBeforeRevocation(revokedAt: Date | null | undefined, authTimeSec: number): boolean {
  return Boolean(revokedAt) && authTimeSec * 1000 < revokedAt!.getTime()
}

/**
 * The person behind a provider session or token, or undefined when Core no
 * longer accepts them. `authTime` is when they signed in (seconds).
 */
export async function loadAccount(mentraUserId: string, authTime: number | undefined) {
  const user = await UserModel.findOne({mentraUserId}, {supportTelemetryDeletedAt: 1, webSignInsRevokedAt: 1}).lean()
  if (!user || isDeletedAccount(user)) return undefined
  if (typeof authTime === "number" && signedInBeforeRevocation(user.webSignInsRevokedAt, authTime)) return undefined
  const identity = await SigninIdentityModel.findOne({mentraUserId}).lean()
  if (!identity || !isSourceEnabled(identity.tenantId, identity.sourceId)) return undefined
  return identity
}
