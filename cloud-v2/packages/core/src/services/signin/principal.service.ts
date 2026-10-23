/**
 * @fileoverview Who is calling Core's portal and workspace APIs.
 *
 * `principalFromBearerOrSession` resolves, in order:
 *  1. an `msk_` / `mak_` bearer: a Core credential, validated as one
 *     (`validateCredentialToken`, which decides on every call who the key still
 *     acts for). A key that does not validate is no principal, and never falls
 *     through to the other kinds;
 *  2. any other bearer: a Core access token from Core's sign-in server
 *     (`verifyCoreAccessToken`: this Core's issuer, Core's API audience, an
 *     active first-party client, and not from before the person's
 *     revocation), giving a person;
 *  3. the portal session cookie of the route group, when the route group has
 *     one: `admin` for `/api/admin`, `portal` for `/api/portal`. Another group's
 *     cookie, or any identity provider's own cookie, authenticates nothing, and
 *     `/api/workspaces` and `/api/organization` take bearers only. The sign-in
 *     server's own cookies authenticate nothing here.
 *
 * `principalFromToken` is the same resolution for a raw bearer token with no
 * browser request around it: the signed service API, where the Store passes
 * the token a person or a key presented to it. Phone tokens, ID tokens,
 * miniapp tokens and tokens from another issuer are refused.
 *
 * A person resolved from a Core access token first claims the Store-imported
 * memberships waiting under their verified email (`claimLegacyIdentitiesOnce`:
 * at most once per ten minutes per person in a process, and a failure never
 * fails the request), so their first Core or Store request already sees them.
 *
 * A person's Organization Admin status is evaluated on every request from the
 * verified email (`isOrganizationAdminEmail`), so an allowlist change applies
 * on the next request. Signing in grants no organization capability by itself.
 */

import type {CorePrincipal as ContractPrincipal} from "@mentra/workspace-contract"
import type {Context} from "hono"
import {getCookie} from "hono/cookie"

import type {AppEnv} from "../../types/hono.types"
import {isOrganizationAdminEmail} from "../admin-email-policy"
import {isCredentialToken, validateCredentialToken} from "../workspaces/credential.service"
import {claimLegacyIdentitiesOnce} from "../workspaces/membership-claim.service"
import {readPortalSession, type PortalKind} from "./browser-session.service"
import {verifyCoreAccessToken} from "../oidc/core-access-token"
import {portalSite, setPortalSessionCookie} from "./portal-signin.service"

/** A person, with what Core knows of how they signed in. */
export type UserPrincipal = Extract<ContractPrincipal, {kind: "user"}> & {
  /** The sign-in source's tenant: `mentra` on hosted Core, or a Private Cloud provider's. */
  tenantId: string
  /** How the person authenticated this request. */
  via: "session" | "bearer"
}

/** A Core credential: a workspace key or an organization operator key. */
export type CredentialPrincipal = Extract<ContractPrincipal, {kind: "credential"}>

/** The caller of a Core API. `wirePrincipal` gives its contract shape for another service. */
export type CorePrincipal = UserPrincipal | CredentialPrincipal

export function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null
  return header.slice("Bearer ".length).trim() || null
}

function userPrincipal(
  person: {mentraUserId: string; tenantId: string; email: string | null; emailVerified: boolean},
  via: "session" | "bearer",
): UserPrincipal {
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

/** The principal a raw bearer token stands for, or null: a Core credential, or a Core access token. */
export async function principalFromToken(token: string): Promise<CorePrincipal | null> {
  const trimmed = typeof token === "string" ? token.trim() : ""
  if (!trimmed) return null
  if (isCredentialToken(trimmed)) return validateCredentialToken(trimmed)
  const identity = await verifyCoreAccessToken(trimmed)
  if (!identity) return null
  await claimLegacyIdentitiesOnce({
    mentraUserId: identity.mentraUserId,
    email: identity.email,
    emailVerified: identity.emailVerified,
  })
  return userPrincipal(identity, "bearer")
}

/**
 * The principal behind a request, or null. `sessionCookie` names the route
 * group's portal session, or null for a route group that takes bearers only.
 */
export async function principalFromBearerOrSession(
  c: Context<AppEnv>,
  opts: {sessionCookie: PortalKind | null},
): Promise<CorePrincipal | null> {
  const token = bearerToken(c.req.header("authorization"))
  if (token) return principalFromToken(token)
  if (!opts.sessionCookie) return null
  const pc = portalSite(opts.sessionCookie)
  if (!pc) return null
  const value = getCookie(c, pc.cookieName)
  if (!value) return null
  const read = await readPortalSession(opts.sessionCookie, value)
  if (!read) return null
  if (read.rotatedCookieValue) setPortalSessionCookie(c, pc, read.rotatedCookieValue)
  return userPrincipal(read.session, "session")
}

/** The principal as the workspace contract describes it, for another service: without Core's own fields. */
export function wirePrincipal(principal: ContractPrincipal): ContractPrincipal {
  if (principal.kind === "user") {
    return {
      kind: "user",
      mentraUserId: principal.mentraUserId,
      email: principal.email,
      emailVerified: principal.emailVerified,
      isOrganizationAdmin: principal.isOrganizationAdmin,
    }
  }
  return {
    kind: "credential",
    credentialId: principal.credentialId,
    credentialKind: principal.credentialKind,
    workspaceId: principal.workspaceId,
    scopes: [...principal.scopes],
    packageNames: [...principal.packageNames],
    label: principal.label,
  }
}
