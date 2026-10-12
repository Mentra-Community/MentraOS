/**
 * @fileoverview Which emails Core trusts as verified, per sign-in source.
 *
 * A verified email drives Organization Admin status, never the key of a Core
 * user. Each source vouches only for what it can prove:
 *  - Supabase (the Mentra account): the account's `email_confirmed_at`. A
 *    Supabase token carries `email_verified` only in user-editable
 *    `user_metadata`, so the token's value is never read.
 *  - A deployment OIDC provider (a Private Cloud's Entra, say): only an email
 *    in one of the provider's `verifiedEmailDomains` (exact match), and only
 *    when the token does not mark it unverified. Entra asserting
 *    `alex@mentra.glass` is display data, not a verified email.
 */

import type {WebIdentityProvider} from "./config"

export interface TrustedEmail {
  email: string | null
  verified: boolean
}

/**
 * The canonical form of an email address: trimmed and lowercased, ASCII only,
 * exactly one `@` with a non-empty local part and domain, no whitespace, and a
 * domain without a trailing dot or empty labels. Anything else is null, so a
 * look-alike or malformed address never matches a listed domain.
 */
export function canonicalEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const email = raw.trim().toLowerCase()
  if (!email || email.length > 320) return null
  // Printable ASCII without spaces only: no Unicode look-alikes.
  if (!/^[\x21-\x7e]+$/.test(email)) return null
  const parts = email.split("@")
  if (parts.length !== 2) return null
  const [local, domain] = parts as [string, string]
  if (!local || !domain) return null
  if (!isCanonicalDomain(domain)) return null
  return email
}

/** A lowercase DNS name: letters, digits and hyphens in dot-separated labels, at least two labels, no trailing dot. */
export function isCanonicalDomain(domain: string): boolean {
  if (domain !== domain.toLowerCase() || domain.length > 253) return false
  const labels = domain.split(".")
  if (labels.length < 2) return false
  return labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
}

export function trustedEmail(input: {
  provider: WebIdentityProvider
  email: unknown
  /** The token's `email_verified` claim. Ignored for Supabase. */
  tokenEmailVerified?: unknown
  /** Supabase only: the account's `email_confirmed_at` is set. */
  supabaseEmailConfirmed?: boolean
}): TrustedEmail {
  const email = canonicalEmail(input.email)
  if (!email) return {email: null, verified: false}
  if (input.provider.kind === "supabase") {
    return {email, verified: input.supabaseEmailConfirmed === true}
  }
  const domain = email.slice(email.indexOf("@") + 1)
  const listed = input.provider.verifiedEmailDomains.includes(domain)
  return {email, verified: listed && input.tokenEmailVerified !== false}
}
