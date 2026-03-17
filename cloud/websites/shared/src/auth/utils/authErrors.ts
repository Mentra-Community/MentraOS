/**
 * Supabase Auth error code to user-friendly message mapping.
 * Based on https://supabase.com/docs/guides/auth/debugging/error-codes
 */
const ERROR_CODE_MAP: Record<string, string> = {
  // Credentials errors
  invalid_credentials: "Invalid email or password. Please try again.",
  anonymous_provider_disabled: "Please enter your email and password.",

  // Password errors
  weak_password: "Password is too weak. Please use a stronger password.",
  same_password: "New password must be different from your current password.",

  // Email errors
  email_exists: "This email is already registered. Try signing in instead.",
  user_already_exists: "This email is already registered. Try signing in instead.",
  email_not_confirmed: "Please check your email and confirm your account first.",
  email_address_invalid: "Please enter a valid email address.",
  email_address_not_authorized: "This email domain is not allowed.",

  // Phone errors
  phone_exists: "This phone number is already registered.",
  phone_not_confirmed: "Please verify your phone number first.",

  // Account status errors
  user_banned: "This account has been suspended.",
  user_not_found: "No account found with this email.",
  signup_disabled: "New registrations are temporarily disabled.",

  // Verification errors
  otp_expired: "Your verification code has expired. Please request a new one.",
  otp_disabled: "Invalid verification code.",
  invalid_reset_link: "This password reset link is invalid or has expired.",

  // Session errors
  session_expired: "Your session has expired. Please sign in again.",
  session_not_found: "Your session has expired. Please sign in again.",
  refresh_token_not_found: "Your session has expired. Please sign in again.",
  refresh_token_already_used: "Your session has expired. Please sign in again.",

  // Rate limiting
  over_request_rate_limit: "Too many attempts. Please wait a moment and try again.",
  over_email_send_rate_limit: "Too many emails sent. Please wait a few minutes.",
  over_sms_send_rate_limit: "Too many SMS sent. Please wait a few minutes.",

  // OAuth/SSO errors
  bad_oauth_callback: "Sign-in failed. Please try again.",
  bad_oauth_state: "Sign-in failed. Please try again.",
  oauth_provider_not_supported: "This sign-in method is not available.",
  provider_disabled: "This sign-in method is not available.",
  provider_email_needs_verification: "Please verify your email first.",

  // MFA errors
  insufficient_aal: "Additional verification required.",
  mfa_verification_failed: "Verification failed. Please try again.",
  mfa_verification_rejected: "Verification failed. Please try again.",
  mfa_challenge_expired: "Verification code expired. Please request a new one.",

  // Network/timeout errors
  request_timeout: "Request timed out. Please check your connection and try again.",
  hook_timeout: "Request timed out. Please try again.",
  hook_timeout_after_retry: "Request timed out. Please try again.",
}

/**
 * Maps raw Supabase/auth error messages to user-friendly strings.
 * This prevents showing cryptic error messages to end users.
 *
 * Per Supabase docs: "Always use error.code and error.name to identify errors,
 * not string matching on error messages"
 */
export const mapAuthError = (error: Error | string | unknown): string => {
  // First try to get the error code (preferred method per Supabase docs)
  const errorCode = typeof error === "object" && error !== null && "code" in error
    ? (error as {code: string}).code
    : null

  if (errorCode && ERROR_CODE_MAP[errorCode]) {
    return ERROR_CODE_MAP[errorCode]
  }

  // Fallback to message matching for errors without codes
  const msg = typeof error === "string"
    ? error.toLowerCase()
    : error instanceof Error
      ? error.message.toLowerCase()
      : ""

  // Invalid credentials
  if (msg.includes("invalid login") || msg.includes("invalid credentials")) {
    return "Invalid email or password. Please try again."
  }

  // Anonymous/empty credentials
  if (msg.includes("anonymous")) {
    return "Please enter your email and password."
  }

  // Password too short
  if (msg.includes("password") && (msg.includes("6") || msg.includes("short") || msg.includes("characters"))) {
    return "Password must be at least 6 characters."
  }

  // Weak password
  if (msg.includes("weak password") || (msg.includes("password") && msg.includes("strength"))) {
    return "Password is too weak. Please use a stronger password."
  }

  // Password same as old
  if (msg.includes("different from the old password") || msg.includes("same password")) {
    return "New password must be different from your current password."
  }

  // Email already registered
  if (
    msg.includes("already registered") ||
    msg.includes("user already registered") ||
    msg.includes("email already exists") ||
    msg.includes("email_exists") ||
    msg.includes("user_already_exists")
  ) {
    return "This email is already registered. Try signing in instead."
  }

  // Phone already registered
  if (msg.includes("phone_exists") || (msg.includes("phone") && msg.includes("already"))) {
    return "This phone number is already registered."
  }

  // Duplicate signup - we already sent verification email
  if (msg.includes("duplicate_signup")) {
    return "We already sent you a verification email. Please check your inbox."
  }

  // OTP/verification code expired
  if (msg.includes("otp") && msg.includes("expired")) {
    return "Your verification code has expired. Please request a new one."
  }

  // Invalid email format
  if (msg.includes("invalid email") || msg.includes("valid email") || msg.includes("email_address_invalid")) {
    return "Please enter a valid email address."
  }

  // User not found
  if (msg.includes("user not found") || msg.includes("no user") || msg.includes("user_not_found")) {
    return "No account found with this email."
  }

  // User banned
  if (msg.includes("banned") || msg.includes("user_banned")) {
    return "This account has been suspended."
  }

  // Email not confirmed
  if (msg.includes("email not confirmed") || msg.includes("not confirmed") || msg.includes("email_not_confirmed")) {
    return "Please check your email and confirm your account first."
  }

  // Phone not confirmed
  if (msg.includes("phone not confirmed") || msg.includes("phone_not_confirmed")) {
    return "Please verify your phone number first."
  }

  // Session expired
  if (msg.includes("session") && (msg.includes("expired") || msg.includes("not found"))) {
    return "Your session has expired. Please sign in again."
  }

  // Refresh token issues
  if (msg.includes("refresh") && msg.includes("token")) {
    return "Your session has expired. Please sign in again."
  }

  // Rate limiting
  if (msg.includes("rate limit") || msg.includes("too many requests") || msg.includes("over_request_rate_limit")) {
    return "Too many attempts. Please wait a moment and try again."
  }

  // Email rate limit
  if (msg.includes("over_email_send_rate_limit") || msg.includes("too many emails")) {
    return "Too many emails sent. Please wait a few minutes."
  }

  // SMS rate limit
  if (msg.includes("over_sms_send_rate_limit") || msg.includes("too many sms")) {
    return "Too many SMS sent. Please wait a few minutes."
  }

  // Signup disabled
  if (msg.includes("signup") && msg.includes("disabled")) {
    return "New registrations are temporarily disabled."
  }

  // OAuth errors
  if (msg.includes("oauth") || (msg.includes("provider") && msg.includes("failed"))) {
    return "Sign-in failed. Please try again."
  }

  // Provider disabled
  if (msg.includes("provider") && msg.includes("disabled")) {
    return "This sign-in method is not available."
  }

  // MFA required
  if (msg.includes("mfa") || msg.includes("insufficient_aal") || msg.includes("authenticator")) {
    return "Additional verification required."
  }

  // Network/connection errors
  if (
    msg.includes("network") ||
    msg.includes("connection") ||
    msg.includes("fetch") ||
    msg.includes("failed to fetch")
  ) {
    return "Connection error. Please check your internet and try again."
  }

  // Timeout errors
  if (msg.includes("timeout") || msg.includes("request_timeout")) {
    return "Request timed out. Please try again."
  }

  // Generic fallback - return a user-friendly generic message
  return "An unexpected error occurred. Please try again."
}
