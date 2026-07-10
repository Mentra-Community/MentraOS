/**
 * @fileoverview Account-flow error type. Mirrors OauthError shape (code +
 * description + httpStatus) so the app.ts error handler renders it as the same
 * RFC-shaped `{ error, error_description }` body. Codes extend the oauth set
 * with the account-specific ones from spec.md.
 */
export type AccountErrorCode =
  | "invalid_request"
  | "invalid_grant"
  | "invalid_credentials"
  | "verification_required"
  | "weak_password"
  | "email_taken"
  | "code_invalid"
  | "rate_limited"
  | "unauthorized_client"
  | "server_error";

export class AccountError extends Error {
  constructor(
    readonly code: AccountErrorCode,
    description: string,
    readonly httpStatus: number,
  ) {
    super(`${code}: ${description}`);
    this.name = "AccountError";
    this.description = description;
  }
  readonly description: string;
}
