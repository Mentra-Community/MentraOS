/**
 * @fileoverview Random values and hashes for web sign-in.
 *
 * Cookie values, `state`, `nonce` and PKCE verifiers are 256-bit random
 * values. Core stores only the SHA-256 of a cookie value, so a database read
 * yields nothing a browser could present.
 */

import {createHash, randomBytes} from "node:crypto"

/** 32 random bytes, base64url (43 characters). */
export function randomToken(): string {
  return randomBytes(32).toString("base64url")
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

/** The PKCE S256 code challenge for a verifier (RFC 7636). */
export function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url")
}
