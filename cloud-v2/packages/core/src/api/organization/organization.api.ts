/**
 * @fileoverview Public organization API, mounted at `/api/organization`.
 *
 * An organization is this Core deployment. `GET /` tells any caller (a person
 * or a credential) what they may do to it; everything else needs an
 * organization capability, and only people exercise it: a Core credential is
 * refused (403 `{error: "forbidden"}`), as in `/api/workspaces`. An operator
 * key (`mak_`) is for the read and testing scopes other APIs gate on, never for
 * administering workspaces or credentials.
 *
 * Conventions match `workspaces.api.ts`: lists are `{items}` (`next` where they
 * page), creating a key is 201 with `cache-control: no-store` and the token in
 * the body once, and DELETE is 204.
 */

import {ORGANIZATION_CAPABILITIES, type OrganizationCapability, type OrganizationView} from "@mentra/workspace-contract"
import {Hono} from "hono"
import {
  createOperatorKey,
  findCredentialOwner,
  listOperatorKeys,
  revokeCredential,
} from "../../services/workspaces/credential.service"
import {organizationCapabilities} from "../../services/workspaces/authorization.service"
import {organizationId} from "../../services/workspaces/organization"
import {fail} from "../../services/workspaces/workspace-error"
import {listAllWorkspaces, recoverOwnership} from "../../services/workspaces/workspace.service"
import {getUser} from "../../services/user.service"
import type {AppEnv} from "../../types/hono.types"
import {
  principalAuth,
  requireOrganizationCapability,
  requireUserPrincipal,
  userActor,
} from "../middleware/principal.middleware"
import {optionalDate, pageLimit, readJsonObject, requiredString, requiredStringArray} from "../workspaces/request"

const app = new Hono<AppEnv>()

// Open to every principal: it is how a caller (a key included) learns what it may do here.
app.get("/", principalAuth, (c) => {
  const principal = c.get("principal")
  if (!principal) return c.json({error: "unauthorized"}, 401)
  const held = organizationCapabilities(principal)
  const view: OrganizationView = {
    organizationId: organizationId(),
    capabilities: ORGANIZATION_CAPABILITIES.filter((capability) => held.has(capability)),
  }
  return c.json(view)
})

// --- Workspaces ------------------------------------------------------------

app.get(
  "/workspaces",
  requireUserPrincipal,
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

app.post(
  "/workspaces/:workspaceId/owners",
  requireUserPrincipal,
  requireOrganizationCapability("organization.workspaces.administer"),
  async (c) => {
    const body = await readJsonObject(c)
    const mentraUserId = requiredString(body, "mentraUserId")
    // Owning a workspace needs a person to own it; a typo must not mint a membership nobody can ever use.
    if (!(await getUser(mentraUserId))) return c.json({error: "user_not_found"}, 404)
    return c.json(await recoverOwnership(userActor(c), c.req.param("workspaceId"), mentraUserId))
  },
)

// --- Operator keys ---------------------------------------------------------

app.get(
  "/credentials",
  requireUserPrincipal,
  requireOrganizationCapability("organization.credentials.manage"),
  async (c) => c.json({items: await listOperatorKeys()}),
)

app.post(
  "/credentials",
  requireUserPrincipal,
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
  requireUserPrincipal,
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

export default app
