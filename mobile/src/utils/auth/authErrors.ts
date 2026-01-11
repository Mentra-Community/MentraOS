import {translate} from "@/i18n"

/**
 * Supabase Auth error code to translation key mapping.
 * Based on https://supabase.com/docs/guides/auth/debugging/error-codes
 */
const ERROR_CODE_MAP: Record<string, string> = {
  // Credentials errors
  invalid_credentials: "login:errors.invalidCredentials",
  anonymous_provider_disabled: "login:errors.enterCredentials",

  // Password errors
  weak_password: "login:errors.weakPassword",
  same_password: "login:errors.passwordSameAsOld",

  // Email errors
  email_exists: "login:errors.emailAlreadyRegistered",
  user_already_exists: "login:errors.emailAlreadyRegistered",
  email_not_confirmed: "login:errors.emailNotConfirmed",
  email_address_invalid: "login:errors.invalidEmailDomain",
  email_address_not_authorized: "login:errors.invalidEmailDomain",

  // Phone errors
  phone_exists: "login:errors.phoneAlreadyRegistered",
  phone_not_confirmed: "login:errors.phoneNotConfirmed",

  // Account status errors
  user_banned: "login:errors.userBanned",
  user_not_found: "login:errors.userNotFound",
  signup_disabled: "login:errors.signupDisabled",

  // Verification errors
  otp_expired: "login:errors.otpExpired",
  otp_disabled: "login:errors.invalidOtp",
  invalid_reset_link: "login:errors.invalidResetLink",

  // Session errors
  session_expired: "login:errors.sessionExpired",
  session_not_found: "login:errors.sessionExpired",
  refresh_token_not_found: "login:errors.refreshTokenExpired",
  refresh_token_already_used: "login:errors.refreshTokenExpired",

  // Rate limiting
  over_request_rate_limit: "login:errors.tooManyAttempts",
  over_email_send_rate_limit: "login:errors.tooManyEmails",
  over_sms_send_rate_limit: "login:errors.tooManySms",

  // OAuth/SSO errors
  bad_oauth_callback: "login:errors.oauthError",
  bad_oauth_state: "login:errors.oauthError",
  oauth_provider_not_supported: "login:errors.providerDisabled",
  provider_disabled: "login:errors.providerDisabled",
  provider_email_needs_verification: "login:errors.emailNotConfirmed",

  // MFA errors
  insufficient_aal: "login:errors.mfaRequired",
  mfa_verification_failed: "login:errors.mfaFailed",
  mfa_verification_rejected: "login:errors.mfaFailed",
  mfa_challenge_expired: "login:errors.otpExpired",

  // Network/timeout errors
  request_timeout: "login:errors.requestTimeout",
  hook_timeout: "login:errors.requestTimeout",
  hook_timeout_after_retry: "login:errors.requestTimeout",
}

/**
 * Maps raw Supabase/auth error messages to user-friendly translated strings.
 * This prevents showing cryptic error messages like "Anonymous sign-ins are disabled"
 * to end users.
 *
 * Per Supabase docs: "Always use error.code and error.name to identify errors,
 * not string matching on error messages"
 */
export const mapAuthError = (error: Error | string): string => {
  // First try to get the error code (preferred method per Supabase docs)
  const errorCode = typeof error === "object" && "code" in error ? (error as any).code : null

  if (errorCode && ERROR_CODE_MAP[errorCode]) {
    return translate(ERROR_CODE_MAP[errorCode])
  }

  // Fallback to message matching for errors without codes
  const msg = typeof error === "string" ? error.toLowerCase() : error.message.toLowerCase()

  // Invalid credentials
  if (msg.includes("invalid login") || msg.includes("invalid credentials")) {
    return translate("login:errors.invalidCredentials")
  }

  // Anonymous/empty credentials
  if (msg.includes("anonymous")) {
    return translate("login:errors.enterCredentials")
  }

  // Password too short
  if (msg.includes("password") && (msg.includes("6") || msg.includes("short") || msg.includes("characters"))) {
    return translate("login:errors.passwordTooShort")
  }

  // Weak password
  if (msg.includes("weak password") || (msg.includes("password") && msg.includes("strength"))) {
    return translate("login:errors.weakPassword")
  }

  // Password same as old
  if (msg.includes("different from the old password") || msg.includes("same password")) {
    return translate("login:errors.passwordSameAsOld")
  }

  // Email already registered
  if (
    msg.includes("already registered") ||
    msg.includes("user already registered") ||
    msg.includes("email already exists") ||
    msg.includes("email_exists") ||
    msg.includes("user_already_exists")
  ) {
    return translate("login:errors.emailAlreadyRegistered")
  }

  // Phone already registered
  if (msg.includes("phone_exists") || (msg.includes("phone") && msg.includes("already"))) {
    return translate("login:errors.phoneAlreadyRegistered")
  }

  // Duplicate signup - we already sent verification email
  if (msg.includes("duplicate_signup")) {
    return translate("login:errors.alreadySentEmail")
  }

  // OTP/verification code expired
  if (msg.includes("otp") && msg.includes("expired")) {
    return translate("login:errors.otpExpired")
  }

  // Invalid email format
  if (msg.includes("invalid email") || msg.includes("valid email") || msg.includes("email_address_invalid")) {
    return translate("login:invalidEmail")
  }

  // User not found
  if (msg.includes("user not found") || msg.includes("no user") || msg.includes("user_not_found")) {
    return translate("login:errors.userNotFound")
  }

  // User banned
  if (msg.includes("banned") || msg.includes("user_banned")) {
    return translate("login:errors.userBanned")
  }

  // Email not confirmed
  if (msg.includes("email not confirmed") || msg.includes("not confirmed") || msg.includes("email_not_confirmed")) {
    return translate("login:errors.emailNotConfirmed")
  }

  // Phone not confirmed
  if (msg.includes("phone not confirmed") || msg.includes("phone_not_confirmed")) {
    return translate("login:errors.phoneNotConfirmed")
  }

  // Session expired
  if (msg.includes("session") && (msg.includes("expired") || msg.includes("not found"))) {
    return translate("login:errors.sessionExpired")
  }

  // Refresh token issues
  if (msg.includes("refresh") && msg.includes("token")) {
    return translate("login:errors.refreshTokenExpired")
  }

  // Rate limiting
  if (msg.includes("rate limit") || msg.includes("too many requests") || msg.includes("over_request_rate_limit")) {
    return translate("login:errors.tooManyAttempts")
  }

  // Email rate limit
  if (msg.includes("over_email_send_rate_limit") || msg.includes("too many emails")) {
    return translate("login:errors.tooManyEmails")
  }

  // SMS rate limit
  if (msg.includes("over_sms_send_rate_limit") || msg.includes("too many sms")) {
    return translate("login:errors.tooManySms")
  }

  // Signup disabled
  if (msg.includes("signup") && msg.includes("disabled")) {
    return translate("login:errors.signupDisabled")
  }

  // OAuth errors
  if (msg.includes("oauth") || (msg.includes("provider") && msg.includes("failed"))) {
    return translate("login:errors.oauthError")
  }

  // Provider disabled
  if (msg.includes("provider") && msg.includes("disabled")) {
    return translate("login:errors.providerDisabled")
  }

  // MFA required
  if (msg.includes("mfa") || msg.includes("insufficient_aal") || msg.includes("authenticator")) {
    return translate("login:errors.mfaRequired")
  }

  // Network/connection errors
  if (
    msg.includes("network") ||
    msg.includes("connection") ||
    msg.includes("fetch") ||
    msg.includes("failed to fetch")
  ) {
    return translate("login:errors.networkError")
  }

  // Timeout errors
  if (msg.includes("timeout") || msg.includes("request_timeout")) {
    return translate("login:errors.requestTimeout")
  }

  // Generic fallback - return a user-friendly generic message
  return translate("login:errors.genericError")
}

/**
 * Special error codes that we throw from our auth client
 * that need special handling (e.g., showing success instead of error)
 */
const AUTH_ERROR_CODES = {
  DUPLICATE_SIGNUP: "DUPLICATE_SIGNUP",
} as const

/**
 * Check if an error is a duplicate signup error
 */
export const isDuplicateSignupError = (error: Error | string): boolean => {
  const msg = typeof error === "string" ? error : error.message
  return msg === AUTH_ERROR_CODES.DUPLICATE_SIGNUP || msg.toLowerCase().includes("duplicate_signup")
}
