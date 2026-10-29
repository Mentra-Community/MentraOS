/**
 * @fileoverview The automatic workspace: every person who signs in to the workspace portal has a workspace.
 *
 * `ensureWorkspace` answers the person's workspace, making one when they have none
 * (`POST /workspaces/ensure`). In one transaction it:
 *
 *  1. refuses a deleted account (`account_deleted`);
 *  2. writes the person's `users` row (`portalWorkspaceAt`), so two ensures at once, two tabs or a retry
 *     racing its own first try, conflict on that row and the one retried finds what the other made;
 *  3. answers the person's oldest workspace (the first `listWorkspacesForUser` gives: the one created
 *     first), when they have one, whatever made it;
 *  4. otherwise applies `createWorkspace`'s rules (a verified email, `CLOUD_CORE_WORKSPACE_CREATION`) and
 *     inserts a workspace marked `automatic: true`, with the person as its Owner, recording
 *     `workspace.created` with `after.automatic: true`.
 *
 * Its name is the person's (`automaticWorkspaceName`): from Core's sign-in record and verified email only,
 * so nothing here assumes a Mentra account. Core does not look at invitations: the portal decides whether
 * to ensure at all, and an automatic workspace made where an invitation would have done gives way.
 *
 * Giving way is for a workspace that **holds nothing** (`workspace-holdings`). Such a workspace gives way
 * (`yieldAutomaticWorkspace`) in the transaction that gives its person a membership in another: it is
 * deleted, recording `joined_another_workspace`. That transaction writes the person's `users` row as an
 * ensure does, so an ensure racing a join cannot answer the workspace the join deletes.
 */

import type {ClientSession} from "mongoose"
import {withTransaction} from "../../connections/mongo.connection"
import {UserModel} from "../../models/user.model"
import {WorkspaceMembershipModel} from "../../models/workspace-membership.model"
import {WorkspaceModel} from "../../models/workspace.model"
import type {MembershipSummary, WorkspaceRole, WorkspaceSummary} from "@mentra/workspace-contract"
import {memberNames} from "./member-names.service"
import {fail} from "./workspace-error"
import {workspacesHoldingNothing} from "./workspace-holdings"
import {
  assertMayCreateWorkspace,
  deleteWorkspaceIn,
  insertWorkspace,
  isId,
  refuseDeletedAccount,
  loadActiveWorkspace,
  WORKSPACE_NAME_MAX_LENGTH,
  type Actor,
} from "./workspace.service"

const NAME_SUFFIX = "'s Workspace"
const NAMELESS = "My Workspace"
/** `workspace.deleted`'s `after.reason` when an automatic workspace gives way to another one. */
const YIELD_REASON = "joined_another_workspace"

/** What `ensureWorkspace` answers: the person's workspace, their membership in it, and whether it was just made. */
export interface EnsuredWorkspace {
  created: boolean
  workspace: WorkspaceSummary
  membership: MembershipSummary
}

/**
 * The name of a person's automatic workspace: their sign-in `name` (trimmed, inner whitespace and control
 * characters collapsed to one space) and "'s Workspace". Without a name, the `email`'s local part with any
 * `+tag` dropped, split on `.`, `_` and `-`, each word's first letter capitalized, joined by spaces
 * (`john.smith+x@…` is "John Smith's Workspace"). Without either, "My Workspace". The person's part is cut,
 * never inside a character, so the whole is at most 80 characters.
 */
export function automaticWorkspaceName(person: {name?: string | null; email?: string | null}): string {
  const own = clean(person.name) || nameFromEmail(person.email)
  if (!own) return NAMELESS
  return `${cut(own, WORKSPACE_NAME_MAX_LENGTH - NAME_SUFFIX.length)}${NAME_SUFFIX}`
}

/**
 * The person's workspace: 200's existing one or 201's new automatic one (see the file header). Refused:
 * a non-person (`forbidden`), a deleted account (`account_deleted`), an account Core has no record of
 * (`user_not_found`), and, only when there is no workspace to answer, an unverified email
 * (`email_unverified`) or a non-admin where only Organization Admins may create workspaces (`forbidden`).
 */
export async function ensureWorkspace(actor: Actor & {kind: "user"}): Promise<EnsuredWorkspace> {
  if (actor?.kind !== "user" || !isId(actor.mentraUserId)) fail("forbidden", "a signed-in user is required")
  const mentraUserId = actor.mentraUserId
  return withTransaction(async session => {
    await refuseDeletedAccount(session, mentraUserId)
    await serializeEnsures(session, mentraUserId)

    const existing = await oldestWorkspaceOf(session, mentraUserId)
    if (existing) return {created: false, ...existing}

    assertMayCreateWorkspace(actor)
    // The name is cosmetic, so it is read outside the transaction's snapshot.
    const signInName = (await memberNames([mentraUserId])).get(mentraUserId)
    const name = automaticWorkspaceName({name: signInName, email: actor.email})
    return {created: true, ...(await insertWorkspace(session, actor, {name, automatic: true}))}
  })
}

/**
 * Delete the person's automatic workspaces that hold nothing (`holdsNothing`), apart from `opts.except`, in
 * `session`: the transaction that gives the person a membership in another workspace (accepting an
 * invitation, claiming an imported membership, recovering ownership). The deletion is
 * `deleteWorkspaceIn`'s, recorded for `actor`, with `workspace.deleted`'s `after.reason` set to
 * `joined_another_workspace`. A workspace that holds anything is left as it is, and so is every workspace
 * the person did not make for themselves: one where they are a Member, or an Owner beside others, or one
 * made with `POST /`. Returns the ids it deleted. The holding is read in `session`, and deleting writes the
 * workspace document, so a change to the workspace made concurrently conflicts with it and is seen on retry.
 */
export async function yieldAutomaticWorkspace(
  session: ClientSession,
  actor: Actor,
  mentraUserId: string,
  opts: {except?: string | null} = {},
): Promise<string[]> {
  if (!isId(mentraUserId)) return []
  // A join and an ensure for the same person conflict here, so an ensure never answers a workspace this
  // join is deleting. A person with no `users` row cannot be ensured, so there is nothing to serialize.
  await serializeEnsures(session, mentraUserId, {required: false})
  const owned = await WorkspaceMembershipModel.distinct("workspaceId", {
    mentraUserId,
    status: "active",
    role: "owner",
  }).session(session)
  const candidates = owned.filter((id): id is string => typeof id === "string" && id !== opts.except)
  if (candidates.length === 0) return []
  const empty = await workspacesHoldingNothing(session, mentraUserId, candidates)
  const yielded: string[] = []
  for (const workspaceId of candidates) {
    if (!empty.has(workspaceId)) continue
    const workspace = await loadActiveWorkspace(session, workspaceId)
    await deleteWorkspaceIn(session, workspace, actor, {reason: YIELD_REASON})
    yielded.push(workspaceId)
  }
  return yielded
}

// --- Helpers ---------------------------------------------------------------

/**
 * Write the person's `users` row in this transaction, so a concurrent ensure's write conflicts with it.
 * `portalWorkspaceAt` becomes now, or a millisecond past its value when the clock has not passed it: a write
 * that changed nothing would conflict with nothing.
 */
async function serializeEnsures(
  session: ClientSession,
  mentraUserId: string,
  opts: {required: boolean} = {required: true},
): Promise<void> {
  const now = new Date()
  const written = await UserModel.updateOne(
    {mentraUserId},
    [{$set: {portalWorkspaceAt: {$max: [now, {$add: [{$ifNull: ["$portalWorkspaceAt", new Date(0)]}, 1]}]}}}],
    {session},
  )
  if (written.matchedCount !== 1 && opts.required) fail("user_not_found", "no such account")
}

/**
 * The person's oldest workspace, with their membership in it, or null: the first of their active
 * workspaces by id (creation order), the order `listWorkspacesForUser` uses.
 */
async function oldestWorkspaceOf(
  session: ClientSession,
  mentraUserId: string,
): Promise<{workspace: WorkspaceSummary; membership: MembershipSummary} | null> {
  const memberships = await WorkspaceMembershipModel.find({mentraUserId, status: "active"})
    .select({_id: 0, workspaceId: 1, membershipId: 1, role: 1})
    .session(session)
    .lean<Array<{workspaceId: string; membershipId: string; role: WorkspaceRole}>>()
  if (memberships.length === 0) return null
  const oldest = await WorkspaceModel.findOne({
    workspaceId: {$in: memberships.map(row => row.workspaceId)},
    status: "active",
  })
    .sort({_id: 1})
    .session(session)
    .lean()
  if (!oldest) return null
  const held = memberships.find(row => row.workspaceId === oldest.workspaceId)!
  const row = oldest
  return {
    workspace: {
      workspaceId: row.workspaceId,
      name: row.name,
      status: "active",
      authorizationRevision: row.authorizationRevision ?? 0,
    },
    membership: {membershipId: held.membershipId, role: held.role},
  }
}

/**
 * Trimmed, with every run of whitespace or control characters one space; "" for anything but a string.
 * Invisible format characters (category Cf: zero-width spaces, bidi marks, the word joiner, the byte order
 * mark) are dropped, so a name made only of them is empty. The two joiners, U+200C and U+200D, are kept
 * inside a name, where they hold emoji sequences and Persian and Indic words together, and trimmed at its
 * ends like whitespace.
 */
function clean(value: unknown): string {
  if (typeof value !== "string") return ""
  return value
    .replace(/(?![\u200c\u200d])\p{Cf}/gu, "")
    .replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/^[\s\u200c\u200d]+|[\s\u200c\u200d]+$/g, "")
}

function nameFromEmail(email: unknown): string {
  if (typeof email !== "string") return ""
  const at = email.lastIndexOf("@")
  if (at <= 0) return ""
  const local = email.slice(0, at).split("+")[0]!
  return clean(
    local
      .split(/[._-]+/)
      .filter(word => word.length > 0)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" "),
  )
}

const GRAPHEMES = new Intl.Segmenter("en", {granularity: "grapheme"})

/** `value` cut to at most `max` UTF-16 units, never inside a character or a grapheme cluster, and with no trailing space. */
function cut(value: string, max: number): string {
  if (value.length <= max) return value
  let out = ""
  for (const {segment} of GRAPHEMES.segment(value)) {
    if (out.length + segment.length > max) break
    out += segment
  }
  return out.trimEnd()
}
