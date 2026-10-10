/**
 * Every message the site shows. All are fixed: no request parameter and no
 * Supabase error message is ever displayed.
 */
export const MESSAGES = {
  notConfigured: "Sign-in is not configured.",
  notFound: "Page not found",
  unexpected: "Something went wrong. Reload the page and try again.",
  invalidLink: "This sign-in link is not valid. Return to the site you came from and try again.",
  authorizeFailed: "We could not finish signing you in. Return to the site you came from and try again.",
  invalidCredentials: "The email or password is not correct.",
  emailNotConfirmed: "Confirm your email address first. Use the link we sent to your inbox.",
  rateLimited: "Too many attempts. Wait a few minutes and try again.",
  signInFailed: "Sign-in did not work. Try again.",
  googleFailed: "Could not open Google sign-in. Try again.",
  appleFailed: "Could not open Apple sign-in. Try again.",
  checkEmail: "Check your email to confirm your Mentra account.",
  signUpFailed: "Could not create your account. Try again.",
  weakPassword: "Choose a stronger password.",
  resetSent: "If an account exists, we sent a reset link.",
  resetFailed: "Could not send the reset link. Try again.",
  passwordUpdated: "Your password is updated.",
  samePassword: "Choose a password that is different from your current one.",
  resetExpired: "This reset link has expired. Request a new one.",
  updatePasswordFailed: "Could not update your password. Try again.",
} as const;
