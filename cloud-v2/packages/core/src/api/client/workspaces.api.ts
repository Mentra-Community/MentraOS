/**
 * @fileoverview `/api/client/workspaces`: the Mentra App's own view of the workspace a person belongs to.
 *
 *   GET  /mine                               the person's workspace, or `{workspace: null}`
 *   GET  /invitations/mine                   invitations addressed to their verified email that they can accept
 *   POST /invitations/:invitationId/accept   join the workspace the invitation is for
 *   POST /invitations/:invitationId/decline  turn it down (idempotent; changes no membership)
 *   POST /leave                              leave the workspace (the only Owner cannot)
 *
 * The gate is the phone's access token (`userAuth`), which carries no email. The person's verified email
 * comes from Core's copy of the account directory's answer (`accountEmail`), so the invitation checks (a
 * verified email equal to the invited address) are exactly those of the web flow; an account with no
 * verified email sees no invitations. A missing or invalid token is 401, as on Fleet's phone routes, so
 * the phone refreshes its session instead of treating it as a bad request.
 *
 * A person belongs to at most one workspace. Accepting while already in one is `already_in_workspace`
 * (409): the phone says "leave first". The membership guard that makes this hold under concurrent
 * accepts lives in the workspace services; the check here is the fast, friendly refusal.
 *
 * Failures of an expected kind arrive as `WorkspaceError` and are rendered by the app's error handler.
 */

import type {
  AcceptInvitationResult,
  DeclineInvitationResult,
  MyWorkspace,
  MyWorkspaceResponse,
  PendingInvitationsResponse,
} from "@mentra/workspace-contract"
import {Hono} from "hono"
import type {MiddlewareHandler} from "hono"
import {accountEmail} from "../../services/account/account-email.service"
import {isOrganizationAdminEmail} from "../../services/admin-email-policy"
import {isDeletedAccountId} from "../../services/user.service"
import {claimLegacyIdentitiesOnce} from "../../services/workspaces/membership-claim.service"
import {
  acceptInvitationById,
  declineInvitation,
  listInvitationsForPerson,
} from "../../services/workspaces/invitation.service"
import {leaveWorkspace, listWorkspacesForUser, type Actor} from "../../services/workspaces/workspace.service"
import {fail} from "../../services/workspaces/workspace-error"
import type {AppContext, AppEnv} from "../../types/hono.types"
import {InvalidGrant, InvalidRequest} from "../../types/oauth.types"
import {userAuth} from "../middleware/user-auth.middleware"

type UserActor = Actor & {kind: "user"}

const app = new Hono<AppEnv>()

/** The phone's Core access token. Anything missing or invalid is 401, never the OAuth 400 `userAuth` throws. */
const phoneAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  try {
    await userAuth(c, async () => {})
  } catch (err) {
    if (err instanceof InvalidRequest || err instanceof InvalidGrant) {
      return c.json({error: "unauthorized", error_description: "sign-in required"}, 401)
    }
    throw err
  }
  return next()
}

/**
 * The signed-in person as the workspace services' actor, or the response that refuses them: 401 for a
 * deleted account, 503 when the account directory cannot say what their email is and Core has no copy.
 * The email is the account's verified one (`accountEmail`: null when unverified), so an invitation is
 * matched exactly as the web flow matches it. Claims memberships waiting under it, once.
 */
async function requireActor(c: AppContext): Promise<UserActor | Response> {
  const user = c.var.user
  if (!user || (await isDeletedAccountId(user.mentraUserId))) {
    return c.json({error: "unauthorized", error_description: "sign-in required"}, 401)
  }
  let email: string | null
  try {
    email = await accountEmail(user.mentraUserId)
  } catch {
    return c.json({error: "unavailable", error_description: "could not confirm your email; try again"}, 503)
  }
  const emailVerified = email !== null
  await claimLegacyIdentitiesOnce({mentraUserId: user.mentraUserId, email, emailVerified})
  return {
    kind: "user",
    mentraUserId: user.mentraUserId,
    email,
    emailVerified,
    isOrganizationAdmin: isOrganizationAdminEmail({email, verified: emailVerified}),
  }
}

/**
 * The person's workspace: their oldest active one. Before the one-workspace cleanup a person can belong to
 * several; the oldest is the one the phone shows until it is done.
 */
async function workspaceOf(mentraUserId: string): Promise<MyWorkspace | null> {
  const [first] = await listWorkspacesForUser(mentraUserId)
  if (!first) return null
  return {
    workspaceId: first.workspaceId,
    name: first.name,
    role: first.membership.role,
    membershipId: first.membership.membershipId,
  }
}

app.use("*", phoneAuth)

app.get("/mine", async c => {
  const actor = await requireActor(c)
  if (actor instanceof Response) return actor
  const body: MyWorkspaceResponse = {workspace: await workspaceOf(actor.mentraUserId)}
  c.header("cache-control", "no-store")
  return c.json(body)
})

app.get("/invitations/mine", async c => {
  const actor = await requireActor(c)
  if (actor instanceof Response) return actor
  const body: PendingInvitationsResponse = {invitations: await listInvitationsForPerson(actor)}
  c.header("cache-control", "no-store")
  return c.json(body)
})

app.post("/invitations/:invitationId/accept", async c => {
  const actor = await requireActor(c)
  if (actor instanceof Response) return actor
  if (await workspaceOf(actor.mentraUserId)) {
    fail("already_in_workspace", "leave your current workspace before joining another")
  }
  await acceptInvitationById(actor, c.req.param("invitationId"))
  const workspace = await workspaceOf(actor.mentraUserId)
  // The membership was just written in the accepting transaction; a missing one means it was removed since.
  if (!workspace) fail("membership_changed", "your membership changed; try again")
  const body: AcceptInvitationResult = {workspace}
  c.header("cache-control", "no-store")
  return c.json(body)
})

app.post("/invitations/:invitationId/decline", async c => {
  const actor = await requireActor(c)
  if (actor instanceof Response) return actor
  const body: DeclineInvitationResult = await declineInvitation(actor, c.req.param("invitationId"))
  c.header("cache-control", "no-store")
  return c.json(body)
})

app.post("/leave", async c => {
  const actor = await requireActor(c)
  if (actor instanceof Response) return actor
  const workspace = await workspaceOf(actor.mentraUserId)
  if (!workspace) fail("not_found", "not a member of any workspace")
  await leaveWorkspace(actor, workspace.workspaceId)
  return c.body(null, 204)
})

export default app
