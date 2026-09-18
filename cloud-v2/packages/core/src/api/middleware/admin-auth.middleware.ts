import {createMiddleware} from "hono/factory"
import {authenticateDeveloperRequest} from "../../services/developer-auth.service"
import type {AppEnv} from "../../types/hono.types"

/**
 * Mentra admin access to Core's own admin surface (incident reports, support
 * profiles).
 *
 * Deliberately self-contained: incident triage is needed most when something
 * else is broken, so it must not depend on another service being up. A WorkOS
 * session cookie covers the admin console; a WorkOS access token covers CLI
 * callers such as scripts/fetch-incident-logs.sh.
 *
 * `msk_` developer-org API keys are not accepted here — those live in the
 * Store's database and are a Store/console credential, not a Core one.
 */
export const adminAuth = createMiddleware<AppEnv>(async (c, next) => {
  const auth = await authenticateDeveloperRequest(c)
  if (!auth.authenticated) {
    return c.json({error: "unauthorized", error_description: "Mentra login required"}, 401)
  }
  if (!isAdminEmail(auth.user.email)) {
    return c.json({error: "forbidden", error_description: "admin access required"}, 403)
  }

  c.set("isAdmin", true)
  c.set("developer", {developerId: auth.user.id, email: auth.user.email})
  return next()
})

function isAdminEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase()
  const emails = parseList(process.env.CLOUD_CORE_ADMIN_EMAILS).map(value => value.toLowerCase())
  if (emails.includes(normalized)) return true

  // Fail closed: without an explicit domain allowlist, do not grant admin via
  // domain matching. Admin access then requires membership in CLOUD_CORE_ADMIN_EMAILS.
  const domains = parseList(process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS)
  return domains.map(domain => domain.toLowerCase().replace(/^@/, "")).some(domain => normalized.endsWith(`@${domain}`))
}

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map(entry => entry.trim())
    .filter(Boolean)
}
