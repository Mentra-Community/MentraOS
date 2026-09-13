/**
 * @fileoverview OAuth 2.0 / RFC 8693 protocol types.
 *
 * The Token Exchange flow (`POST /api/client/auth/exchange`) and the Refresh
 * flow (`POST /api/client/auth/refresh`) both return responses and errors in
 * RFC-defined shapes. Services throw `OauthError` subtypes; the API layer
 * catches them and renders the wire response.
 *
 * Spec: docs/issues/001-cloud-core/auth/spec.md ("Endpoints")
 *       RFC 6749 §5.2 (token endpoint error response)
 *       RFC 8693 §2.2.2 (token-exchange error response — same shape)
 */

/**
 * RFC-defined error code strings. The `error` field of the response body.
 */
export type OauthErrorCode =
  | "invalid_request" // malformed body, missing required claims
  | "invalid_grant" // subject_token bad signature, expired, replayed
  | "unauthorized_client" // OEM unknown or disabled
  | "unsupported_grant_type" // grant_type not the token-exchange URN
  | "server_error" // Mentra-side problem (DB, key fetch, ...)

/**
 * Base error thrown by auth-related services. Each subclass fixes its
 * `code`; callers throw the subclass with a human-readable description.
 *
 * The API layer renders these to the RFC body shape:
 *   { error: <code>, error_description: <description> }
 */
export class OauthError extends Error {
  constructor(
    readonly code: OauthErrorCode,
    readonly description: string,
    readonly httpStatus: number,
  ) {
    super(`${code}: ${description}`)
    this.name = "OauthError"
  }
}

export class InvalidRequest extends OauthError {
  constructor(description: string) {
    super("invalid_request", description, 400)
  }
}

export class InvalidGrant extends OauthError {
  constructor(description: string) {
    super("invalid_grant", description, 400)
  }
}

export class UnauthorizedClient extends OauthError {
  constructor(description: string) {
    super("unauthorized_client", description, 401)
  }
}

export class UnsupportedGrantType extends OauthError {
  constructor(description: string) {
    super("unsupported_grant_type", description, 400)
  }
}

export class OauthServerError extends OauthError {
  constructor(description: string) {
    super("server_error", description, 500)
  }
}

/**
 * Successful token-exchange / refresh response (RFC 6749 §5.1).
 */
export interface TokenResponse {
  access_token: string
  refresh_token: string
  token_type: "Bearer"
  expires_in: number // seconds until access-token expiry
}
