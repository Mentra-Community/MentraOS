/**
 * @fileoverview Public workspace API, mounted at `/api/workspaces`.
 *
 * Workspace administration is done by signed-in people: a Core credential
 * (`msk_` / `mak_`) is refused on every route here (403 `{error: "forbidden"}`)
 * before anything else runs. Each route then has a capability gate
 * (`requireWorkspaceCapability`), which decides from the caller's role in the
 * workspace; the services behind it enforce the finer rules (who may change
 * which role, the last-owner guard, who may revoke a credential), so the gates
 * here are deliberately the coarse "may you be looking at this at all".
 *
 * Bodies are validated by hand (`request.ts`), failures of an expected kind
 * arrive as `WorkspaceError` and are rendered by the app's error handler.
 *
 * Response conventions: a list is `{items}` (with `next` where it pages), a
 * single resource is the object itself, a create that hands out a secret
 * (credentials, invitation links) is 201 with `cache-control: no-store`, and a
 * DELETE (or any other call with nothing to say) is 204. The response types are
 * the contract's (`@mentra/workspace-contract`), shared with the dashboard and CLI.
 *
 * Route order matters: `/invitations/...` is registered before `/:workspaceId`
 * so the literal segment is never read as a workspace id.
 */

import {
  capabilitiesForRole,
  WORKSPACE_ROLES,
  type AuditEventView,
  type InvitationView,
  type MemberView,
  type WorkspaceDetail,
  type WorkspaceRole,
  type WorkspaceSummary,
} from "@mentra/workspace-contract"
import {Hono} from "hono"
import type {WorkspaceAuditEventRow} from "../../models/workspace-audit-event.model"
import {listWorkspaceAudit, redactSecrets} from "../../services/workspaces/audit.service"
import {
  createWorkspaceCredential,
  findCredentialOwner,
  listWorkspaceCredentials,
  revokeCredential,
} from "../../services/workspaces/credential.service"
import {
  acceptInvitation,
  createInvitation,
  listPendingInvitations,
  peekInvitation,
  revokeInvitation,
  type InvitationRow,
} from "../../services/workspaces/invitation.service"
import {countStorePackages} from "../../services/workspaces/store-package-count"
import {fail} from "../../services/workspaces/workspace-error"
import {
  changeRole,
  createWorkspace,
  deleteWorkspace,
  getActiveMembership,
  isWorkspaceRole,
  leaveWorkspace,
  listMembers,
  listWorkspacesForUser,
  removeMember,
  renameWorkspace,
  type MembershipRow,
} from "../../services/workspaces/workspace.service"
import type {AppContext, AppEnv} from "../../types/hono.types"
import {requireUserPrincipal, requireWorkspaceCapability, userActor} from "../middleware/principal.middleware"
import {
  expectedRevision,
  optionalDate,
  optionalStringArray,
  pageLimit,
  readJsonObject,
  requiredString,
  type JsonObject,
} from "./request"

const app = new Hono<AppEnv>()

// People only. This also authenticates the request (401 without a principal), so no route is open.
app.use("*", requireUserPrincipal)

// --- The caller's workspaces -----------------------------------------------

app.get("/", async (c) => {
  const items = await listWorkspacesForUser(userActor(c).mentraUserId)
  return c.json({items})
})

app.post("/", async (c) => {
  const actor = userActor(c)
  const body = await readJsonObject(c)
  const summary = await createWorkspace(actor, {name: requiredString(body, "name")})
  // The creator is the workspace's owner, and its only member so far.
  const detail: WorkspaceDetail = {
    ...summary,
    membership: await ownerMembership(summary.workspaceId, actor.mentraUserId),
    capabilities: [...capabilitiesForRole("owner")],
  }
  return c.json(detail, 201)
})

// --- Invitation links (before `/:workspaceId`) -----------------------------
// The token travels in the body, never the path: request logs record the path.

app.post("/invitations/peek", async (c) => {
  const body = await readJsonObject(c)
  const invitation = await peekInvitation(requiredString(body, "token"))
  if (!invitation) fail("invitation_not_found", "invitation not found")
  c.header("cache-control", "no-store")
  return c.json(invitation)
})

app.post("/invitations/accept", async (c) => {
  const actor = userActor(c)
  const body = await readJsonObject(c)
  return c.json(await acceptInvitation(actor, requiredString(body, "token")))
})

// --- One workspace ---------------------------------------------------------

app.get("/:workspaceId", requireWorkspaceCapability("workspace.read"), (c) => c.json(workspaceDetail(c)))

app.patch("/:workspaceId", requireWorkspaceCapability("workspace.settings.manage"), async (c) => {
  const body = await readJsonObject(c)
  const summary = await renameWorkspace(
    userActor(c),
    c.req.param("workspaceId"),
    requiredString(body, "name"),
    expectedRevision(body),
  )
  return c.json(workspaceDetail(c, summary))
})

app.delete("/:workspaceId", requireWorkspaceCapability("workspace.delete"), async (c) => {
  const body = await readJsonObject(c)
  const workspaceId = c.req.param("workspaceId")
  await deleteWorkspace(userActor(c), workspaceId, {
    confirmName: requiredString(body, "confirmName"),
    ownedPackageCount: () => countStorePackages(workspaceId),
  })
  return c.body(null, 204)
})

// --- Members ---------------------------------------------------------------

app.get("/:workspaceId/members", requireWorkspaceCapability("workspace.members.read"), async (c) => {
  const rows = await listMembers(c.req.param("workspaceId"))
  return c.json({items: rows.map(memberView)})
})

app.patch("/:workspaceId/members/:membershipId", requireWorkspaceCapability("workspace.read"), async (c) => {
  const body = await readJsonObject(c)
  const summary = await changeRole(
    userActor(c),
    c.req.param("workspaceId"),
    c.req.param("membershipId"),
    workspaceRole(body),
    expectedRevision(body),
  )
  return c.json(summary)
})

app.delete("/:workspaceId/members/:membershipId", requireWorkspaceCapability("workspace.read"), async (c) => {
  const body = await readJsonObject(c)
  await removeMember(userActor(c), c.req.param("workspaceId"), c.req.param("membershipId"), expectedRevision(body))
  return c.body(null, 204)
})

app.post("/:workspaceId/leave", requireWorkspaceCapability("workspace.read"), async (c) => {
  await leaveWorkspace(userActor(c), c.req.param("workspaceId"))
  return c.body(null, 204)
})

// --- Invitations -----------------------------------------------------------

app.get("/:workspaceId/invitations", requireWorkspaceCapability("workspace.members.manage"), async (c) => {
  const rows = await listPendingInvitations(c.req.param("workspaceId"))
  return c.json({items: rows.map(invitationView)})
})

app.post("/:workspaceId/invitations", requireWorkspaceCapability("workspace.members.manage"), async (c) => {
  const body = await readJsonObject(c)
  const created = await createInvitation(userActor(c), c.req.param("workspaceId"), {
    email: requiredString(body, "email"),
    role: workspaceRole(body),
  })
  // The link carries the only copy of the invitation token.
  c.header("cache-control", "no-store")
  return c.json(
    {invitationId: created.invitationId, inviteUrl: created.inviteUrl, expiresAt: created.expiresAt.toISOString()},
    201,
  )
})

app.delete(
  "/:workspaceId/invitations/:invitationId",
  requireWorkspaceCapability("workspace.members.manage"),
  async (c) => {
    await revokeInvitation(userActor(c), c.req.param("workspaceId"), c.req.param("invitationId"))
    return c.body(null, 204)
  },
)

// --- Credentials -----------------------------------------------------------

app.get("/:workspaceId/credentials", requireWorkspaceCapability("miniapps.credentials.create"), async (c) => {
  return c.json({items: await listWorkspaceCredentials(c.req.param("workspaceId"))})
})

app.post("/:workspaceId/credentials", requireWorkspaceCapability("miniapps.credentials.create"), async (c) => {
  const body = await readJsonObject(c)
  const input: {name: string; packageNames?: string[]; expiresAt: Date | null} = {
    name: requiredString(body, "name"),
    expiresAt: optionalDate(body, "expiresAt"),
  }
  const packageNames = optionalStringArray(body, "packageNames")
  if (packageNames) input.packageNames = packageNames
  const created = await createWorkspaceCredential(userActor(c), c.req.param("workspaceId"), input)
  // The token is shown exactly once.
  c.header("cache-control", "no-store")
  return c.json(created, 201)
})

// The route's gate is plain membership: the service decides whether this caller may revoke this key.
app.delete("/:workspaceId/credentials/:credentialId", requireWorkspaceCapability("workspace.read"), async (c) => {
  const workspaceId = c.req.param("workspaceId")
  const credentialId = c.req.param("credentialId")
  // The service decides by the credential's own workspace, so the URL must name that workspace too.
  const owner = await findCredentialOwner(credentialId)
  if (owner?.credentialKind !== "workspace" || owner.workspaceId !== workspaceId) {
    fail("not_found", "credential not found")
  }
  await revokeCredential(userActor(c), credentialId)
  return c.body(null, 204)
})

// --- Audit -----------------------------------------------------------------

app.get("/:workspaceId/audit", requireWorkspaceCapability("workspace.audit.read"), async (c) => {
  const size = pageLimit(c)
  const before = c.req.query("before")
  // One more than the page, to know whether there is another page without a trailing empty one.
  const rows = await listWorkspaceAudit(c.req.param("workspaceId"), {limit: size + 1, ...(before ? {before} : {})})
  const page = rows.slice(0, size)
  return c.json({
    items: page.map(auditEventView),
    next: rows.length > size ? page[page.length - 1]!.eventId : null,
  })
})

// --- Helpers ---------------------------------------------------------------

/**
 * The workspace as the caller sees it: the summary (the one the gate loaded, or a fresh one from a
 * mutation) with the caller's membership and capabilities from the gate's decision.
 */
function workspaceDetail(c: AppContext, summary?: WorkspaceSummary): WorkspaceDetail {
  const decision = c.get("workspaceAuthorization")
  const workspace = summary ?? decision?.workspace
  if (!decision?.allowed || !workspace) throw new Error("a workspace route ran without its authorization decision")
  return {...workspace, membership: decision.membership ?? null, capabilities: decision.capabilities}
}

async function ownerMembership(workspaceId: string, mentraUserId: string): Promise<WorkspaceDetail["membership"]> {
  const row = await getActiveMembership(workspaceId, mentraUserId)
  return row ? {membershipId: row.membershipId, role: "owner"} : null
}

function workspaceRole(body: JsonObject): WorkspaceRole {
  const role = body.role
  if (!isWorkspaceRole(role)) fail("invalid_role", `role must be one of ${WORKSPACE_ROLES.join(", ")}`)
  return role
}

function memberView(row: MembershipRow): MemberView {
  return {
    membershipId: row.membershipId,
    mentraUserId: row.mentraUserId ?? null,
    email: row.email ?? null,
    name: row.name ?? null,
    role: row.role as WorkspaceRole,
    startedAt: row.startedAt.toISOString(),
    // A migrated member has no Mentra user until they first sign in.
    pending: !row.mentraUserId,
  }
}

function invitationView(row: InvitationRow): InvitationView {
  return {
    invitationId: row.invitationId,
    email: row.email,
    role: row.role,
    expiresAt: row.expiresAt.toISOString(),
    invitedByMembershipId: row.invitedByMembershipId,
  }
}

/** An audit snapshot for display, with anything credential-looking stripped even if a writer ever put it there. */
function snapshot(value: unknown): Record<string, unknown> | null {
  return value ? (redactSecrets(value) as Record<string, unknown>) : null
}

function auditEventView(row: WorkspaceAuditEventRow): AuditEventView {
  return {
    eventId: row.eventId,
    action: row.action,
    actor: {
      kind: row.actor.kind,
      email: row.actor.email ?? null,
      credentialId: row.actor.credentialId ?? null,
      service: row.actor.service ?? null,
    },
    target: snapshot(row.target),
    before: snapshot(row.before),
    after: snapshot(row.after),
    occurredAt: row.occurredAt.toISOString(),
  }
}

export default app
