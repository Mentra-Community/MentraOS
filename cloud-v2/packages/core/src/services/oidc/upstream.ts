/**
 * @fileoverview A Mentra Private Cloud's sign-in: Core's sign-in server is a
 * confidential client of the customer's identity provider (Microsoft Entra in
 * the reference recipe), named by the provider's `browser` settings in
 * `CLOUD_CORE_OIDC_PROVIDERS`.
 *
 * The provider's login step runs the authorization code flow there, with S256
 * PKCE, `state` and `nonce`, and `client_secret_post`. The redirect URI is
 * fixed: `<issuer>/interaction/callback/<provider id>`. Core verifies the ID
 * token itself with jose against the provider's pinned key set: `iss`, `aud`
 * equal to Core's client ID (and `azp` when `aud` has several values), the
 * provider's algorithms, `nonce`, expiry, the directory tenant and the subject
 * claim. The person is `(provider tenantId, subject claim)`, the same Core user
 * as their phone, and their email is verified only in the provider's
 * `verifiedEmailDomains`.
 */

import * as client from "openid-client"

import {ConfigurationError, type WebIdentityProvider} from "../signin/config"
import {trustedEmail} from "../signin/email-trust"
import {IdentityProviderUnavailableError} from "../signin/idp-tokens"
import {KeySetUnavailableError, verifyWithKeySet} from "../signin/key-sets"
import {allowsInsecureIssuer} from "./config"

const DISCOVERY_TTL_MS = 60 * 60_000
const ID_TOKEN_CLOCK_TOLERANCE_SEC = 30

/** The provider refused the sign-in (as opposed to an outage). */
export class UpstreamSignInRefused extends Error {
  override name = "UpstreamSignInRefused"
}

export interface UpstreamIdentity {
  subject: string
  email: string | null
  emailVerified: boolean
  name: string | null
  issuedAt: Date
}

/** The fixed callback of Core's sign-in server at the provider. */
export function upstreamRedirectUri(issuer: string, provider: WebIdentityProvider): string {
  return `${issuer}/interaction/callback/${encodeURIComponent(provider.sourceId)}`
}

function upstreamClient(provider: WebIdentityProvider): {clientId: string; secret: string; scopes: string} {
  const browser = provider.browser
  const secret = browser ? (process.env[browser.clientSecretEnv] ?? "").trim() : ""
  if (!browser || !secret) throw new ConfigurationError(`the sign-in source "${provider.sourceId}" has no browser settings`)
  return {clientId: browser.clientId, secret, scopes: browser.scopes.join(" ")}
}

const configurations = new Map<string, {config: client.Configuration; expiresAt: number}>()

/** Forget cached discovery (tests, and a changed configuration). */
export function resetUpstreamCaches(): void {
  configurations.clear()
}

/** The provider's OpenID configuration for Core's client, cached for an hour, with `jwks_uri` pinned. */
async function upstreamConfiguration(provider: WebIdentityProvider): Promise<client.Configuration> {
  const {clientId, secret} = upstreamClient(provider)
  const key = `${provider.issuer}|${clientId}`
  const cached = configurations.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.config
  const insecure = allowsInsecureIssuer(provider.issuer)
  const auth = client.ClientSecretPost(secret)
  const discovered = await client.discovery(
    new URL(provider.issuer),
    clientId,
    {client_secret: secret},
    auth,
    insecure ? {execute: [client.allowInsecureRequests]} : undefined,
  )
  const metadata = JSON.parse(JSON.stringify(discovered.serverMetadata())) as client.ServerMetadata
  const config = new client.Configuration({...metadata, jwks_uri: provider.jwksUrl}, clientId, {client_secret: secret}, auth)
  if (insecure) client.allowInsecureRequests(config)
  configurations.set(key, {config, expiresAt: Date.now() + DISCOVERY_TTL_MS})
  return config
}

/** The provider's authorization URL for this sign-in. Throws on a discovery outage. */
export async function upstreamAuthorizationUrl(
  provider: WebIdentityProvider,
  redirectUri: string,
  tx: {state: string; nonce: string; codeChallenge: string},
): Promise<URL> {
  const config = await upstreamConfiguration(provider)
  return client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: upstreamClient(provider).scopes,
    state: tx.state,
    nonce: tx.nonce,
    code_challenge: tx.codeChallenge,
    code_challenge_method: "S256",
  })
}

/**
 * Redeem the provider's code and verify its ID token. Throws
 * UpstreamSignInRefused for anything the provider or the token gets wrong,
 * and IdentityProviderUnavailableError for an outage.
 */
export async function finishUpstreamSignIn(
  provider: WebIdentityProvider,
  callbackUrl: URL,
  tx: {state: string; nonce: string; pkceVerifier: string},
): Promise<UpstreamIdentity> {
  const config = await upstreamConfiguration(provider)
  let tokens
  try {
    tokens = await client.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: tx.pkceVerifier,
      expectedState: tx.state,
      expectedNonce: tx.nonce,
      idTokenExpected: true,
    })
  } catch (err) {
    const status = (err as {status?: unknown}).status
    const code = (err as {code?: unknown}).code
    const protocol = err instanceof client.ClientError || (typeof code === "string" && code.startsWith("OAUTH_"))
    if (protocol && !(typeof status === "number" && status >= 500)) throw new UpstreamSignInRefused("the provider refused the code exchange")
    throw new IdentityProviderUnavailableError("the identity provider could not be reached")
  }
  return verifyUpstreamIdToken(provider, upstreamClient(provider).clientId, tokens.id_token, tx.nonce)
}

/** Verify the provider's ID token with jose against its pinned key set, as Core's client. */
export async function verifyUpstreamIdToken(
  provider: WebIdentityProvider,
  clientId: string,
  idToken: string | undefined,
  nonce: string,
): Promise<UpstreamIdentity> {
  if (!idToken) throw new UpstreamSignInRefused("no ID token")
  let payload
  try {
    ;({payload} = await verifyWithKeySet(idToken, provider.jwksUrl, {
      issuer: provider.issuer,
      audience: clientId,
      algorithms: provider.algorithms,
      clockTolerance: ID_TOKEN_CLOCK_TOLERANCE_SEC,
    }))
  } catch (err) {
    if (err instanceof KeySetUnavailableError) throw new IdentityProviderUnavailableError(err.message)
    throw new UpstreamSignInRefused("ID token refused")
  }
  if (payload.nonce !== nonce) throw new UpstreamSignInRefused("ID token nonce mismatch")
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId) throw new UpstreamSignInRefused("ID token azp mismatch")
  if (provider.expectedDirectoryTenantId) {
    const directoryTenant = provider.directoryTenantClaim ? payload[provider.directoryTenantClaim] : undefined
    if (directoryTenant !== provider.expectedDirectoryTenantId) throw new UpstreamSignInRefused("ID token directory tenant mismatch")
  }
  const subject = payload[provider.subjectClaim]
  if (typeof subject !== "string" || !subject) throw new UpstreamSignInRefused("ID token has no subject")
  const email = trustedEmail({provider, email: payload[provider.browser?.emailClaim ?? "email"], tokenEmailVerified: payload.email_verified})
  return {
    subject,
    email: email.email,
    emailVerified: email.verified,
    name: typeof payload.name === "string" && payload.name ? payload.name : null,
    issuedAt: typeof payload.iat === "number" ? new Date(payload.iat * 1000) : new Date(),
  }
}
