/**
 * @fileoverview The organization API: what a caller may do to this Core
 * deployment, every workspace in it, and operator keys. One set of handlers,
 * mounted at `/api/organization` (bearers: Core keys and identity-provider
 * access tokens) and at `/api/admin/organization` (the admin portal's session).
 *
 * `GET /` tells any caller (a person or a credential) what they may do here;
 * everything else needs an organization capability, held by an Organization
 * Admin (all of them) or an operator key (`mak_`, the scopes it was created
 * with). A workspace key holds none, so it is refused (403 `{error:
 * "forbidden"}`) everywhere but `GET /`.
 *
 * One rule is not a scope: a key never creates a credential. Creating an
 * operator key (`POST /credentials`) is a person's (403 for any key), so a
 * leaked key cannot mint another that outlives its own revocation. A key
 * holding `organization.credentials.manage` lists and revokes operator keys.
 *
 * Workspaces: `GET /workspaces` lists every workspace; `POST /workspaces`
 * creates one whose first Owner is the person the body names (`owner: {email}`
 * on hosted Core, or `owner: {mentraUserId}`), the caller not becoming a member;
 * `POST /workspaces/:workspaceId/owners` makes a person an Owner of an existing
 * one. All three need `organization.workspaces.administer`.
 *
 * Conventions match `workspaces.api.ts`: lists are `{items}` (`next` where they
 * page), creating is 201 (a key with `cache-control: no-store` and the token in
 * the body once), and DELETE is 204.
 */

import type {OrganizationCapability} from "@mentra/workspace-contract"
import {Hono} from "hono"
import {findAccountByEmail, isGotrueAdminConfigured} from "../../services/account/gotrue.client"
import {MENTRA_TENANT_ID} from "../../services/signin/config"
import {findOrCreateUser} from "../../services/user.service"
import {organizationView} from "../../services/workspaces/authorization.service"
import {
  createOperatorKey,
  findCredentialOwner,
  listOperatorKeys,
  revokeCredential,
} from "../../services/workspaces/credential.service"
import {fail} from "../../services/workspaces/workspace-error"
import {
  createWorkspaceForOwner,
  listAllWorkspaces,
  recoverOwnership,
} from "../../services/workspaces/workspace.service"
import type {AppEnv} from "../../types/hono.types"
import {InvalidRequest} from "../../types/oauth.types"
import {
  principalAuth,
  requestActor,
  requireOrganizationCapability,
  requirePersonOrOperatorKey,
  requireUserPrincipal,
  userActor,
} from "../middleware/principal.middleware"
import {
  optionalDate,
  pageLimit,
  readJsonObject,
  requiredString,
  requiredStringArray,
  type JsonObject,
} from "../workspaces/request"

/** The organization routes, for mounting under a route group. */
export function createOrganizationApi(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // Open to every principal: it is how a caller (a key included) learns what it may do here.
  app.get("/", principalAuth(), (c) => c.json(organizationView(c.get("principal")!)))

  const administersWorkspaces = [
    requirePersonOrOperatorKey(),
    requireOrganizationCapability("organization.workspaces.administer"),
  ] as const
  const managesCredentials = [
    requirePersonOrOperatorKey(),
    requireOrganizationCapability("organization.credentials.manage"),
  ] as const

  // --- Workspaces ------------------------------------------------------------

  app.get("/workspaces", ...administersWorkspaces, async (c) => {
    const size = pageLimit(c)
    const before = c.req.query("before")
    // One more than the page, to know whether there is another page without a trailing empty one.
    const rows = await listAllWorkspaces({limit: size + 1, ...(before ? {before} : {})})
    const items = rows.slice(0, size)
    return c.json({items, next: rows.length > size ? items[items.length - 1]!.workspaceId : null})
  })

  // Create a workspace for someone: `{name, owner: {email} | {mentraUserId}}`. The person named becomes its
  // first Owner; the caller is not a member. 404 `user_not_found` when no such person exists.
  app.post("/workspaces", ...administersWorkspaces, async (c) => {
    const body = await readJsonObject(c)
    const name = requiredString(body, "name")
    const owner = await namedPerson(ownerObject(body))
    if (!owner) return c.json({error: "user_not_found", error_description: "no such person"}, 404)
    const created = await createWorkspaceForOwner(requestActor(c), {name, owner})
    return c.json(created, 201)
  })

  // Make a person an owner of a workspace (ownership recovery). The person is named by their Core user id,
  // or on hosted Core by their account's confirmed email.
  app.post("/workspaces/:workspaceId/owners", ...administersWorkspaces, async (c) => {
    const owner = await namedPerson(await readJsonObject(c))
    // Owning a workspace needs a person to own it; a typo must not mint a membership nobody can ever use.
    // `recoverOwnership` also refuses an id that names no user, or a deleted account's tombstone.
    if (!owner) return c.json({error: "user_not_found", error_description: "no such person"}, 404)
    // The confirmed address the person was found by is how the members list and the audit log name them.
    return c.json(
      await recoverOwnership(requestActor(c), c.req.param("workspaceId"), owner.mentraUserId, {email: owner.email}),
    )
  })

  // --- Operator keys ---------------------------------------------------------

  app.get("/credentials", ...managesCredentials, async (c) => c.json({items: await listOperatorKeys()}))

  // A person only: a key never creates a credential, so a leaked key cannot outlive its own revocation.
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

  app.delete("/credentials/:credentialId", ...managesCredentials, async (c) => {
    const credentialId = c.req.param("credentialId")
    // This route is for operator keys; a workspace's credentials are revoked through their workspace.
    const owner = await findCredentialOwner(credentialId)
    if (owner?.credentialKind !== "organization") fail("not_found", "credential not found")
    await revokeCredential(requestActor(c), credentialId)
    return c.body(null, 204)
  })

  return app
}

/** `body.owner`, the person a new workspace is for: an object naming them by `email` or `mentraUserId` (400 otherwise). */
function ownerObject(body: JsonObject): JsonObject {
  const owner = body.owner
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) {
    throw new InvalidRequest("owner must be {email} or {mentraUserId}")
  }
  return owner as JsonObject
}

/**
 * The person `named` names: by `email` (a confirmed Mentra account's address, hosted Core only) or by
 * `mentraUserId`, with the address they were named by. Null when no account has that address confirmed.
 */
async function namedPerson(named: JsonObject): Promise<{mentraUserId: string; email: string | null} | null> {
  const email = named.email !== undefined ? canonicalOwnerEmail(requiredString(named, "email")) : null
  const mentraUserId = email !== null ? await userIdForEmail(email) : requiredString(named, "mentraUserId").trim()
  return mentraUserId ? {mentraUserId, email} : null
}

/** An owner named by email: trimmed and lowercased, and refused (400) unless it is one address. */
function canonicalOwnerEmail(raw: string): string {
  const email = raw.trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new InvalidRequest("email must be an email address")
  return email
}

/** The Core user of the Mentra account whose confirmed email this is (created on first use), or null. */
async function userIdForEmail(email: string): Promise<string | null> {
  if (!isGotrueAdminConfigured()) throw new InvalidRequest("this deployment names people by their Mentra user id")
  const identity = await findAccountByEmail(email)
  if (!identity?.emailConfirmed) return null
  return (await findOrCreateUser({tenantId: MENTRA_TENANT_ID, tenantUserId: identity.id})).mentraUserId
}
