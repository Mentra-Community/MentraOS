/**
 * @fileoverview The client-side error types every module throws.
 *
 * These are distinct from the protocol's `ProtocolError` (which is a wire
 * payload from the cloud). These are JS errors thrown locally so a host can
 * branch with `instanceof` instead of string-matching messages.
 *
 * See docs/issues/004-cloud-client/design.md.
 */

/** Base class so a host can catch every cloud-client error with one check. */
export class CloudClientError extends Error {
  constructor(message: string) {
    super(message);
    // Without this, `instanceof` checks fail once the code is transpiled down to
    // ES5-class semantics, since the prototype chain gets reset by `super`.
    this.name = "CloudClientError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * A non-2xx HTTP response from a REST call.
 *
 * `status` is the HTTP status so a caller can branch (for example a 401 triggers
 * one refresh-and-retry). `code` is the optional machine-readable error code the
 * cloud puts in the JSON body, when present, for finer branching than status
 * alone allows.
 */
export class HttpError extends CloudClientError {
  status!: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a token refresh fails and the host must send the user back through
 * login. Separate from `HttpError` so a host can catch the "credentials are
 * truly dead" case on its own without inspecting status codes.
 */
export class AuthExpiredError extends CloudClientError {
  constructor(message = "Authentication expired; re-auth required") {
    super(message);
    this.name = "AuthExpiredError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
