/**
 * @fileoverview The signing key of Core's sign-in server.
 *
 * The provider signs ID tokens and access tokens with Core's own Ed25519
 * signing key (`MENTRA_JWT_PRIVATE_KEY`), under its own key ID
 * (`mentra-oidc-1`). Core publishes the public half in its key set
 * (`/.well-known/jwks.json`), the same key set the Store and miniapp backends
 * read, and the provider's discovery names that key set as `jwks_uri`.
 *
 * Tokens from the provider and Core's phone tokens never pass for each other:
 * they carry different issuers (`CLOUD_CORE_OIDC_ISSUER` against
 * `CLOUD_CORE_ISSUER`), audiences and key IDs, and every verifier pins all
 * three.
 */

import * as jose from "jose"

// Kept free of imports from signing-keys.service, which imports this module to publish the key.
export const OIDC_TOKEN_KID = "mentra-oidc-1"
export const OIDC_TOKEN_ALG = "EdDSA"

function requireEnv(name: "MENTRA_JWT_PRIVATE_KEY" | "MENTRA_JWT_PUBLIC_KEY"): string {
  const value = name === "MENTRA_JWT_PRIVATE_KEY" ? process.env.MENTRA_JWT_PRIVATE_KEY : process.env.MENTRA_JWT_PUBLIC_KEY
  if (!value) throw new Error(`env var ${name} is not set`)
  return value
}

function toPem(base64Body: string, label: "PRIVATE KEY" | "PUBLIC KEY"): string {
  return `-----BEGIN ${label}-----\n${base64Body}\n-----END ${label}-----`
}

let signingJwk: Promise<jose.JWK> | null = null
let verificationKey: Promise<jose.KeyLike> | null = null

/** The provider's private signing key as a JWK, for `oidc-provider`'s `jwks` setting. */
export function oidcSigningJwk(): Promise<jose.JWK> {
  signingJwk ??= (async () => {
    const privateKey = await jose.importPKCS8(toPem(requireEnv("MENTRA_JWT_PRIVATE_KEY"), "PRIVATE KEY"), OIDC_TOKEN_ALG, {
      extractable: true,
    })
    const jwk = await jose.exportJWK(privateKey)
    return {...jwk, kid: OIDC_TOKEN_KID, alg: OIDC_TOKEN_ALG, use: "sig"}
  })()
  return signingJwk
}

/** The public key that verifies the provider's tokens, read locally (no key set fetch). */
export function oidcVerificationKey(): Promise<jose.KeyLike> {
  verificationKey ??= jose.importSPKI(toPem(requireEnv("MENTRA_JWT_PUBLIC_KEY"), "PUBLIC KEY"), OIDC_TOKEN_ALG)
  return verificationKey
}

/** Forget the cached keys (tests that change `MENTRA_JWT_*`). */
export function resetOidcKeyCache(): void {
  signingJwk = null
  verificationKey = null
}
