import {authenticateWorkosRequest, type DeveloperAuthResult} from "@mentra/developer-auth"
import type {AppContext} from "../types/hono.types"

export async function authenticateDeveloperRequest(c: AppContext): Promise<DeveloperAuthResult> {
  const apiKey = process.env.WORKOS_API_KEY
  const clientId = process.env.WORKOS_CLIENT_ID
  const cookiePassword = process.env.WORKOS_COOKIE_PASSWORD
  if (!apiKey || !clientId || !cookiePassword) return {authenticated: false, reason: "workos_not_configured"}
  return authenticateWorkosRequest(c, {
    apiKey,
    clientId,
    cookiePassword,
    sessionCookieName: "mentra_console_session",
    secureCookies: process.env.NODE_ENV === "production",
  })
}
