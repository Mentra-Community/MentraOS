/**
 * Every message the site shows. All are fixed: no request parameter and no
 * Supabase error message is ever displayed.
 */
export const MESSAGES = {
  notConfigured: "Sign-in is not configured.",
  notFound: "Page not found",
  unexpected: "Something went wrong. Reload the page and try again.",
  invalidLink: "This sign-in link is not valid. Return to the site you came from and try again.",
  signInExpired: "This sign-in has expired. Return to the site you came from and start again.",
  authorizeFailed: "We could not finish signing you in. Return to the site you came from and try again.",
  signInRefused: "We could not sign you in with that account. Try again.",
  invalidCredentials: "The email or password is not correct.",
  emailNotConfirmed: "Confirm your email address first. Use the link we sent to your inbox.",
  rateLimited: "Too many attempts. Wait a few minutes and try again.",
  signInFailed: "Sign-in did not work. Try again.",
  googleFailed: "Could not open Google sign-in. Try again.",
  appleFailed: "Could not open Apple sign-in. Try again.",
  checkEmail: "Check your email to confirm your Mentra account.",
  signUpFailed: "Could not create your account. Try again.",
  weakPassword: "Choose a stronger password.",
  resetSent: "If an account exists for that email, we sent it a reset code.",
  resetFailed: "Could not reset your password. Try again.",
  invalidCode: "That code is not valid or has expired. Request a new one.",
  passwordUpdated: "Your password is updated. Sign in with your new password.",
  emailVerified: "Your email has been verified. Open the Mentra app to continue.",
  emailLinkFailed: "This link is invalid or has expired. Open the Mentra app to request a new one.",
} as const;
