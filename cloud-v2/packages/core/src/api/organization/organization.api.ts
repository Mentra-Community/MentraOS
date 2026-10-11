/**
 * @fileoverview The organization API: what a caller may do to this Core
 * deployment, every workspace in it, and operator keys. One set of handlers,
 * mounted at `/api/organization` (bearers: Core keys and identity-provider
 * access tokens) and at `/api/admin/organization` (the admin portal's session).
 *
 * `GET /` tells any caller (a person or a credential) what they may do here;
 * everything else needs an organization capability, and only people exercise
 * it: a Core credential is refused (403 `{error: "forbidden"}`), as in the
 * workspace API. An operator key (`mak_`) is for the read and testing scopes
 * other APIs gate on, never for administering workspaces or credentials.
 *
 * Conventions match `workspaces.api.ts`: lists are `{items}` (`next` where they
 * page), creating a key is 201 with `cache-control: no-store` and the token in
 * the body once, and DELETE is 204.
 */

import type {OrganizationCapability} from "@mentra/workspace-contract"
import {Hono} from "hono"
import {findUserByEmail, isGotrueAdminConfigured} from "../../services/account/gotrue.client"
import {MENTRA_TENANT_ID} from "../../services/signin/config"
import {findOrCreateUser, getUser} from "../../services/user.service"
import {organizationView} from "../../services/workspaces/authorization.service"
import {
  createOperatorKey,
  findCredentialOwner,
  listOperatorKeys,
  revokeCredential,
} from "../../services/workspaces/credential.service"
import {fail} from "../../services/workspaces/workspace-error"
import {listAllWorkspaces, recoverOwnership} from "../../services/workspaces/workspace.service"
import type {AppEnv} from "../../types/hono.types"
import {InvalidRequest} from "../../types/oauth.types"
import {
  principalAuth,
  requireOrganizationCapability,
  requireUserPrincipal,
  userActor,
} from "../middleware/principal.middleware"
import {optionalDate, pageLimit, readJsonObject, requiredString, requiredStringArray} from "../workspaces/request"

/** The organization routes, for mounting under a route group. */
export function createOrganizationApi(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // Open to every principal: it is how a caller (a key included) learns what it may do here.
  app.get("/", principalAuth(), (c) => c.json(organizationView(c.get("principal")!)))

  // --- Workspaces ------------------------------------------------------------

  app.get(
    "/workspaces",
    requireUserPrincipal(),
    requireOrganizationCapability("organization.workspaces.administer"),
    async (c) => {
      const size = pageLimit(c)
      const before = c.req.query("before")
      // One more than the page, to know whether there is another page without a trailing empty one.
      const rows = await listAllWorkspaces({limit: size + 1, ...(before ? {before} : {})})
      const items = rows.slice(0, size)
      return c.json({items, next: rows.length > size ? items[items.length - 1]!.workspaceId : null})
    },
  )

  // Make a person an owner of a workspace (ownership recovery). The person is named by their Core user id,
  // or on hosted Core by their account's confirmed email.
  app.post(
    "/workspaces/:workspaceId/owners",
    requireUserPrincipal(),
    requireOrganizationCapability("organization.workspaces.administer"),
    async (c) => {
      const body = await readJsonObject(c)
      const mentraUserId =
        body.email !== undefined ? await userIdForEmail(requiredString(body, "email")) : await knownUserId(body)
      // Owning a workspace needs a person to own it; a typo must not mint a membership nobody can ever use.
      if (!mentraUserId) return c.json({error: "user_not_found", error_description: "no such person"}, 404)
      return c.json(await recoverOwnership(userActor(c), c.req.param("workspaceId"), mentraUserId))
    },
  )

  // --- Operator keys ---------------------------------------------------------

  app.get(
    "/credentials",
    requireUserPrincipal(),
    requireOrganizationCapability("organization.credentials.manage"),
    async (c) => c.json({items: await listOperatorKeys()}),
  )

  app.post(
    "/credentials",
    requireUserPrincipal(),
    requireOrganizationCapability("organization.credentials.manage"),
    async (c) => {
      const actor = userActor(c)
      const body = await readJsonObject(c)
      const created = await createOperatorKey(actor, {
        name: requiredString(body, "name"),
        // The service checks every scope against the operator scopes.
        scopes: requiredStringArray(body, "scopes") as OrganizationCapability[],
        expiresAt: optionalDate(body, "expiresAt"),
      })
      // The token is shown exactly once.
      c.header("cache-control", "no-store")
      return c.json(created, 201)
    },
  )

  app.delete(
    "/credentials/:credentialId",
    requireUserPrincipal(),
    requireOrganizationCapability("organization.credentials.manage"),
    async (c) => {
      const credentialId = c.req.param("credentialId")
      // This route is for operator keys; a workspace's credentials are revoked through their workspace.
      const owner = await findCredentialOwner(credentialId)
      if (owner?.credentialKind !== "organization") fail("not_found", "credential not found")
      await revokeCredential(userActor(c), credentialId)
      return c.body(null, 204)
    },
  )

  return app
}

/** The `mentraUserId` in the body, when it names a Core user. */
async function knownUserId(body: Record<string, unknown>): Promise<string | null> {
  const mentraUserId = requiredString(body, "mentraUserId").trim()
  return (await getUser(mentraUserId)) ? mentraUserId : null
}

/** The Core user of the Mentra account whose confirmed email this is (created on first use), or null. */
async function userIdForEmail(raw: string): Promise<string | null> {
  const email = raw.trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new InvalidRequest("email must be an email address")
  if (!isGotrueAdminConfigured()) throw new InvalidRequest("this deployment names people by their Mentra user id")
  const identity = await findUserByEmail(email)
  if (!identity?.emailConfirmed) return null
  return (await findOrCreateUser({tenantId: MENTRA_TENANT_ID, tenantUserId: identity.id})).mentraUserId
}
