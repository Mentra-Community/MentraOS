/**
 * @fileoverview Read the claims out of a JWT without verifying its signature.
 *
 * The client is not a security boundary for its own token: the cloud verifies
 * the signature on every call. So here we only need to read claims the client
 * already trusts (its own `mentraUserId`, `tenant_id`, and `exp` for the refresh
 * timing), and we deliberately skip signature checks. Doing a real verification
 * would mean shipping the cloud's public keys to the device, which buys nothing.
 *
 * See docs/issues/004-cloud-client/design.md ("cloud.auth", identity) and
 * docs/issues/001-cloud-core/auth/spec.md (access-token claims).
 */

/**
 * The claims this client reads off an access token.
 *
 * `sub` is the `mentraUserId`, `tenant_id` is the issuing OEM, and `exp` is the
 * Unix-seconds expiry used to decide when to refresh. The index signature keeps
 * the rest of the claims (`sessionId`, `jti`, `aud`, `iss`) accessible without
 * naming each one, since the client only acts on these three.
 */
export interface JwtClaims {
  sub: string;
  tenant_id: string;
  exp: number;
  [k: string]: unknown;
}

/**
 * Decode one base64url segment to a UTF-8 string.
 *
 * JWT segments are base64url (with `-`/`_` and no padding), which `atob` does
 * not accept directly, so we translate to standard base64 and re-pad first. We
 * avoid Node's `Buffer` on purpose: this code also runs on the phone (React
 * Native / Hermes), where `Buffer` is not guaranteed but `atob` is. We then
 * rebuild the UTF-8 bytes by hand because `atob` yields a binary (latin1)
 * string, so a multi-byte claim value (a non-ASCII display name, say) would be
 * mangled if read directly.
 */
function decodeBase64UrlToUtf8(segment: string): string {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  // Re-pad to a multiple of 4 so `atob` accepts the input.
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");

  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  // TextDecoder exists on both a modern phone and a modern server, and turns the
  // raw bytes back into a proper UTF-8 string.
  return new TextDecoder().decode(bytes);
}

/**
 * Pull the claims out of a JWT's payload segment.
 *
 * A JWT is three dot-separated base64url segments (`header.payload.signature`);
 * the claims live in the middle one. We throw a plain `Error` on a malformed
 * token rather than returning a partial object, so a caller never acts on
 * half-decoded identity.
 */
export function decodeClaims(jwt: string): JwtClaims {
  const segments = jwt.split(".");
  if (segments.length < 2) {
    throw new Error("decodeClaims: not a JWT (expected at least two segments)");
  }

  let claims: unknown;
  try {
    claims = JSON.parse(decodeBase64UrlToUtf8(segments[1]!));
  } catch {
    // Either the segment is not valid base64url or the payload is not JSON.
    throw new Error("decodeClaims: JWT payload is not valid base64url JSON");
  }

  if (typeof claims !== "object" || claims === null) {
    throw new Error("decodeClaims: JWT payload is not an object");
  }

  return claims as JwtClaims;
}
