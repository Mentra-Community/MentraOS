/**
 * @fileoverview The signing key of Core's sign-in server.
 *
 * The provider signs ID tokens and access tokens with Core's own Ed25519
 * signing key (`MENTRA_JWT_PRIVATE_KEY`), under its own key ID
 * (`mentra-oidc-1`). Core publishes the public half in its key set
 * (`/.well-known/jwks.json`), the same key set the Store and miniapp backends
 * read, and the provider's discovery names that key set as `jwks_uri`.
 *
 * Tokens from the provider and Core's other tokens never pass for each other,
 * even on a Private Cloud where the provider's issuer and `CLOUD_CORE_ISSUER`
 * are both Core's own host: every verifier pins the key ID and the token type
 * as well as the issuer and audience.
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

// Cached per key value, so a changed key takes effect on the next use.
let signingJwk: {source: string; jwk: Promise<jose.JWK>} | null = null
let verificationKey: {source: string; key: Promise<jose.KeyLike>} | null = null

/** The provider's private signing key as a JWK, for `oidc-provider`'s `jwks` setting. */
export function oidcSigningJwk(): Promise<jose.JWK> {
  const source = requireEnv("MENTRA_JWT_PRIVATE_KEY")
  if (signingJwk?.source !== source) {
    signingJwk = {
      source,
      jwk: (async () => {
        const privateKey = await jose.importPKCS8(toPem(source, "PRIVATE KEY"), OIDC_TOKEN_ALG, {extractable: true})
        const jwk = await jose.exportJWK(privateKey)
        return {...jwk, kid: OIDC_TOKEN_KID, alg: OIDC_TOKEN_ALG, use: "sig"}
      })(),
    }
  }
  return signingJwk.jwk
}

/** The public key that verifies the provider's tokens, read locally (no key set fetch). */
export function oidcVerificationKey(): Promise<jose.KeyLike> {
  const source = requireEnv("MENTRA_JWT_PUBLIC_KEY")
  if (verificationKey?.source !== source) {
    verificationKey = {source, key: jose.importSPKI(toPem(source, "PUBLIC KEY"), OIDC_TOKEN_ALG)}
  }
  return verificationKey.key
}

/** Forget the cached keys (tests). */
export function resetOidcKeyCache(): void {
  signingJwk = null
  verificationKey = null
}
