/**
 * @fileoverview Whether Core counts an account as verified: a person whose sign-in Core can vouch for. Only a
 * verified account makes Core read miniapp URLs into its registry (`api/client/registry.api.ts`).
 *
 * One rule, by where the account signs in:
 *  - a Mentra account (tenant `mentra`): its email is verified, in Core's copy of the account directory's answer
 *    (`accountEmail`);
 *  - an account from one of this Core's own identity providers (`CLOUD_CORE_OIDC_PROVIDERS`, a Private Cloud's
 *    Entra, say): always. The deployment's operator configured that provider to sign in its people, so signing in
 *    through it is the proof. Such a Core has no account directory to ask about an email. The provider must still be
 *    configured: removing it ends the trust;
 *  - anyone else (an OEM's people, an enterprise trusted issuer's): never. Core has no email it can check for them,
 *    and their sign-in is someone else's to vouch for.
 */

import {isConfiguredOidcTenant} from "../oem.service"
import {MENTRA_TENANT_ID} from "../signin/config"
import {accountEmail} from "./account-email.service"

/** The signed-in account, as the phone's Core access token names it. */
export interface AccountPrincipal {
  mentraUserId: string
  tenantId: string
}

/**
 * Whether `principal` is a verified account. Throws only when it is a Mentra account and the account directory
 * can't say (no copy of its answer, and the directory down); `signal` cancels that lookup.
 */
export async function accountIsVerified(
  principal: AccountPrincipal,
  options: {signal?: AbortSignal} = {},
): Promise<boolean> {
  if (principal.tenantId !== MENTRA_TENANT_ID) return isConfiguredOidcTenant(principal.tenantId)
  return (await accountEmail(principal.mentraUserId, options)) !== null
}
