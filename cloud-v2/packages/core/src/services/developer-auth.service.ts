import {
  authenticateWorkosAccessToken,
  authenticateWorkosRequest,
  type DeveloperAuthOptions,
  type DeveloperAuthResult,
} from "@mentra/developer-auth"
import type {AppContext} from "../types/hono.types"

/** The WorkOS settings from the environment, or null when WorkOS is not configured here. */
function workosOptions(): DeveloperAuthOptions | null {
  const apiKey = process.env.WORKOS_API_KEY
  const clientId = process.env.WORKOS_CLIENT_ID
  const cookiePassword = process.env.WORKOS_COOKIE_PASSWORD
  if (!apiKey || !clientId || !cookiePassword) return null
  return {
    apiKey,
    clientId,
    cookiePassword,
    sessionCookieName: "mentra_console_session",
    secureCookies: process.env.NODE_ENV === "production",
  }
}

export async function authenticateDeveloperRequest(c: AppContext): Promise<DeveloperAuthResult> {
  const options = workosOptions()
  if (!options) return {authenticated: false, reason: "workos_not_configured"}
  return authenticateWorkosRequest(c, options)
}

/**
 * Authenticate a bare WorkOS access token, for callers with no browser request
 * (the internal service API). Same verification as the bearer path of
 * {@link authenticateDeveloperRequest}.
 */
export async function authenticateDeveloperAccessToken(token: string): Promise<DeveloperAuthResult> {
  const options = workosOptions()
  if (!options) return {authenticated: false, reason: "workos_not_configured"}
  return authenticateWorkosAccessToken(token, options)
}
