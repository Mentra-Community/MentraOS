/**
 * @fileoverview The admin API gate (`/api/admin/*`).
 *
 * Requires an Organization Admin: a person signed in to the admin portal (or
 * presenting an identity-provider access token) whose verified email is on the
 * allowlist, or an allowlisted organization API key. Sets `c.var.developer`
 * (the caller's ID and label) for the audit fields the admin routes record.
 */

import {createMiddleware} from "hono/factory"

import type {AppEnv} from "../../types/hono.types"
import {principalLabel, requireOrganizationAdmin} from "./principal.middleware"

const organizationAdmin = requireOrganizationAdmin("admin")

export const adminAuth = createMiddleware<AppEnv>(async (c, next) => {
  return organizationAdmin(c, async () => {
    const principal = c.get("principal")!
    c.set("isAdmin", true)
    c.set("developer", {
      developerId: principal.kind === "user" ? principal.mentraUserId : `api_key:${principal.credentialId}`,
      email: principalLabel(principal),
    })
    await next()
  })
})
