/**
 * @fileoverview Who is calling Core's portal APIs.
 *
 * `principalFromBearerOrSession` resolves, in order:
 *  1. an `msk_` / `mak_` bearer: a Core credential (today an organization API
 *     key; an allowlisted one, `api-key@<keyId>.local`, acts as an
 *     Organization Admin, as before). A key that does not validate is no
 *     principal, and never falls through to the other kinds;
 *  2. any other bearer: an identity-provider access token
 *     (`verifyIdpAccessToken`), giving a person;
 *  3. the portal session cookie of the route group: `admin` for `/api/admin`,
 *     `portal` for `/api/portal`. Another group's cookie, or any identity
 *     provider's own cookie, authenticates nothing.
 *
 * A person's Organization Admin status is evaluated on every request from the
 * verified email (`isOrganizationAdminEmail`), so an allowlist change applies
 * on the next request. Signing in grants no organization capability by itself.
 */

import type {Context} from "hono"
import {getCookie} from "hono/cookie"

import type {AppEnv} from "../../types/hono.types"
import {isAdminEmail, isOrganizationAdminEmail} from "../admin-email-policy"
import {apiKeyEnvironmentLabel, DeveloperApiKeyService} from "../developer-orgs/developer-api-key.service"
import {readPortalSession, type PortalKind} from "./browser-session.service"
import {verifyIdpAccessToken} from "./idp-tokens"
import {portalClientIfConfigured, setPortalSessionCookie} from "./portal-signin.service"

export type CorePrincipal =
  | {
      kind: "user"
      mentraUserId: string
      tenantId: string
      email: string | null
      emailVerified: boolean
      isOrganizationAdmin: boolean
      /** How the person authenticated this request. */
      via: "session" | "bearer"
    }
  | {
      kind: "credential"
      credentialId: string
      /** The key's synthetic identity, `api-key@<keyId>.local`. */
      label: string
      isOrganizationAdmin: boolean
    }

const CREDENTIAL_PREFIX = /^m[sa]k_/
const apiKeys = new DeveloperApiKeyService()

export function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null
  return header.slice("Bearer ".length).trim() || null
}

async function credentialPrincipal(token: string): Promise<CorePrincipal | null> {
  const validated = await apiKeys.validate(token, apiKeyEnvironmentLabel())
  if (!validated) return null
  const label = `api-key@${validated.keyId}.local`
  return {kind: "credential", credentialId: validated.keyId, label, isOrganizationAdmin: isAdminEmail(label)}
}

function userPrincipal(
  person: {mentraUserId: string; tenantId: string; email: string | null; emailVerified: boolean},
  via: "session" | "bearer",
): CorePrincipal {
  return {
    kind: "user",
    mentraUserId: person.mentraUserId,
    tenantId: person.tenantId,
    email: person.email,
    emailVerified: person.emailVerified,
    isOrganizationAdmin: isOrganizationAdminEmail({email: person.email, verified: person.emailVerified}),
    via,
  }
}

/**
 * The principal behind a request, or null. Throws
 * IdentityProviderUnavailableError when a bearer's identity provider cannot be
 * asked (callers answer 503).
 */
export async function principalFromBearerOrSession(
  c: Context<AppEnv>,
  opts: {sessionCookie: PortalKind},
): Promise<CorePrincipal | null> {
  const token = bearerToken(c.req.header("authorization"))
  if (token) {
    if (CREDENTIAL_PREFIX.test(token)) return credentialPrincipal(token)
    const identity = await verifyIdpAccessToken(token)
    return identity ? userPrincipal(identity, "bearer") : null
  }
  const pc = portalClientIfConfigured(opts.sessionCookie)
  if (!pc) return null
  const value = getCookie(c, pc.cookieName)
  if (!value) return null
  const read = await readPortalSession(opts.sessionCookie, value)
  if (!read) return null
  if (read.rotatedCookieValue) setPortalSessionCookie(c, pc, read.rotatedCookieValue)
  return userPrincipal(read.session, "session")
}
