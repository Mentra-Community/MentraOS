/**
 * @fileoverview Bring everyone who holds several workspace memberships down to one.
 *
 * Usage:
 *
 *   bun packages/core/scripts/one-workspace-cleanup.ts --target <mongo-url> [--apply] [--i-understand-remote]
 *
 * One workspace per person is enforced by the guard (`membership-guard.service.ts`) from the release that
 * ships it; people who already held several memberships keep them until this script runs, and until then
 * every further join is refused. Ship the guard first, run the dry run, review it, then apply: the script
 * never runs before the guard refuses new extras.
 *
 * Without `--apply` it prints a JSON report and writes nothing. With `--apply`, for each person with several
 * active memberships it
 *  - keeps the highest role, then the earliest join (`startedAt`), then the smallest membership id;
 *  - ends each other membership through Core's normal removal, in its own transaction with the usual
 *    revision check: the workspace's revision is bumped, the keys and invitations of that membership are
 *    revoked, its seats released and `membership.removed` recorded (as the system), so each removal is
 *    audited and on the change feed. A concurrent change to the workspace (`membership_changed`) makes the
 *    script plan that person again, so a stale plan never removes the wrong membership;
 *  - where the membership to end is its workspace's last Owner, first promotes the workspace's next member
 *    (highest role, earliest joined; `membership.role_changed`, as the system);
 *  - **sole-owner exception:** where there is no other member to promote because the membership is the only
 *    one the workspace has, it is ended anyway. This script alone bypasses the last-Owner protection, and
 *    only in that case. A workspace with other members that cannot be promoted (an imported member nobody has
 *    claimed) is left as it is and reported under `blocked`, with its person still in several workspaces;
 *  - writes the person's guard for the membership they keep.
 * It then writes the guard for everyone with exactly one membership who has none (`initializeGuards`), and
 * reports every workspace left with no Owner (`ownerless`). A re-run finds nothing left to do.
 *
 * `--apply` refuses a non-local database unless `--i-understand-remote` is passed, as the other operator
 * scripts do.
 */

import {WORKSPACE_ROLES} from "@mentra/workspace-contract"
import mongoose from "mongoose"
import {withTransaction} from "../src/connections/mongo.connection"
import {WorkspaceMembershipModel} from "../src/models/workspace-membership.model"
import {WorkspaceModel, type WorkspaceRow} from "../src/models/workspace.model"
import {recordWorkspaceEvent} from "../src/services/workspaces/audit.service"
import {initializeGuards, setGuard} from "../src/services/workspaces/membership-guard.service"
import {WorkspaceError} from "../src/services/workspaces/workspace-error"
import {
  bumpRevision,
  countActiveOwners,
  endMembership,
  loadActiveWorkspace,
  roleEntry,
  type MembershipRow,
} from "../src/services/workspaces/workspace.service"
import {isDeletedAccountId} from "../src/services/user.service"
import {isLocalMongoUrl, splitMongoUrl} from "./mongo-url"

const SYSTEM = {kind: "system"} as const
/** How many times a person is planned again after a concurrent change before the script gives up on them. */
const MAX_ATTEMPTS = 5

export class UsageError extends Error {}

export interface CleanupOptions {
  apply: boolean
  log?: (message: string) => void
}

export interface PlannedEnd {
  workspaceId: string
  membershipId: string
  role: string
  /** The member promoted to Owner first, when this was the workspace's last Owner and someone could be. */
  promoted?: {membershipId: string; mentraUserId: string; role: string}
  /** The membership was its workspace's only one: ended although it is the last Owner. */
  soleMember?: boolean
}

export interface PersonPlan {
  mentraUserId: string
  kept: {workspaceId: string; membershipId: string; role: string}
  ended: PlannedEnd[]
  /** Memberships that cannot be ended: the workspace has other members, none of whom can be promoted. */
  blocked: Array<{workspaceId: string; membershipId: string; role: string; reason: "no_member_to_promote"}>
}

export interface CleanupReport {
  apply: boolean
  people: PersonPlan[]
  /** Workspaces that have, or will have, no Owner once the plan is done. */
  ownerless: string[]
  /** Guards written for people who hold exactly one membership and had none (apply only). */
  guardsWritten: number
  /** People the script gave up on after repeated concurrent changes (apply only). */
  gaveUp: string[]
}

const rank = (role: string): number => (WORKSPACE_ROLES as readonly string[]).indexOf(role)

/** The kept membership first: highest role, earliest join, smallest id. */
export function keepOrder(a: MembershipRow, b: MembershipRow): number {
  return (
    rank(b.role) - rank(a.role) ||
    a.startedAt.getTime() - b.startedAt.getTime() ||
    (a.membershipId < b.membershipId ? -1 : a.membershipId > b.membershipId ? 1 : 0)
  )
}

async function peopleWithSeveral(): Promise<string[]> {
  const rows = await WorkspaceMembershipModel.aggregate<{_id: string}>([
    {$match: {status: "active", mentraUserId: {$type: "string"}}},
    {$group: {_id: "$mentraUserId", count: {$sum: 1}}},
    {$match: {count: {$gt: 1}}},
    {$sort: {_id: 1}},
  ])
  return rows.map(row => row._id)
}

/** The person's plan against the database as it is now (inside `session` when given). */
async function planPerson(mentraUserId: string, session: mongoose.ClientSession | null): Promise<PersonPlan | null> {
  const held = await WorkspaceMembershipModel.find({mentraUserId, status: "active"}).session(session).lean<MembershipRow[]>()
  if (held.length < 2) return null
  const [kept, ...extras] = [...held].sort(keepOrder)
  const plan: PersonPlan = {
    mentraUserId,
    kept: {workspaceId: kept!.workspaceId, membershipId: kept!.membershipId, role: kept!.role},
    ended: [],
    blocked: [],
  }
  for (const extra of extras) {
    const end: PlannedEnd = {workspaceId: extra.workspaceId, membershipId: extra.membershipId, role: extra.role}
    if (extra.role === "owner" && (await countActiveOwners(extra.workspaceId, session ?? undefined)) <= 1) {
      const others = await WorkspaceMembershipModel.find({
        workspaceId: extra.workspaceId,
        status: "active",
        membershipId: {$ne: extra.membershipId},
      })
        .session(session)
        .lean<MembershipRow[]>()
      if (others.length === 0) {
        end.soleMember = true
      } else {
        const next = await nextToPromote(others, session)
        if (!next) {
          plan.blocked.push({
            workspaceId: extra.workspaceId,
            membershipId: extra.membershipId,
            role: extra.role,
            reason: "no_member_to_promote",
          })
          continue
        }
        end.promoted = {membershipId: next.membershipId, mentraUserId: next.mentraUserId as string, role: next.role}
      }
    }
    plan.ended.push(end)
  }
  return plan
}

/** The workspace's next member to take ownership: an account that exists, highest role, earliest joined. */
async function nextToPromote(others: MembershipRow[], session: mongoose.ClientSession | null): Promise<MembershipRow | null> {
  const candidates: MembershipRow[] = []
  for (const row of others) {
    if (typeof row.mentraUserId !== "string" || row.mentraUserId.length === 0) continue
    if (await isDeletedAccountId(row.mentraUserId, session ?? undefined)) continue
    candidates.push(row)
  }
  return candidates.sort(keepOrder)[0] ?? null
}

/** End one membership of `plan`'s person, in its own transaction. Throws `membership_changed` on a stale plan. */
async function applyEnd(plan: PersonPlan, end: PlannedEnd): Promise<void> {
  await withTransaction(async session => {
    const workspace: WorkspaceRow = await loadActiveWorkspace(session, end.workspaceId)
    const membership = await WorkspaceMembershipModel.findOne({
      membershipId: end.membershipId,
      workspaceId: end.workspaceId,
      status: "active",
    })
      .session(session)
      .lean<MembershipRow>()
    if (!membership || membership.mentraUserId !== plan.mentraUserId || membership.role !== end.role) {
      throw new WorkspaceError("membership_changed", 409, "the membership changed since it was planned")
    }
    // The usual revision check: the plan was made at the revision the workspace had, and writing it first is
    // what serializes this with every other change there.
    const updated = await bumpRevision(session, end.workspaceId, workspace.authorizationRevision)

    if (end.promoted) {
      const promoted = await WorkspaceMembershipModel.findOne({
        membershipId: end.promoted.membershipId,
        workspaceId: end.workspaceId,
        status: "active",
        role: end.promoted.role,
      })
        .session(session)
        .lean<MembershipRow>()
      if (!promoted) throw new WorkspaceError("membership_changed", 409, "the member to promote changed")
      await WorkspaceMembershipModel.updateOne(
        {membershipId: promoted.membershipId, status: "active"},
        {$set: {role: "owner"}, $push: {roleHistory: roleEntry("owner", new Date(), updated.authorizationRevision)}},
        {session},
      )
      await recordWorkspaceEvent(session, {
        workspaceId: end.workspaceId,
        action: "membership.role_changed",
        actor: SYSTEM,
        target: {
          membershipId: promoted.membershipId,
          mentraUserId: promoted.mentraUserId ?? null,
          email: promoted.email ?? null,
        },
        before: {role: promoted.role},
        after: {role: "owner"},
      })
    } else if (end.soleMember) {
      // The sole-owner exception holds only while the workspace has no other member.
      const others = await WorkspaceMembershipModel.countDocuments({
        workspaceId: end.workspaceId,
        status: "active",
        membershipId: {$ne: end.membershipId},
      }).session(session)
      if (others > 0) throw new WorkspaceError("membership_changed", 409, "the workspace gained a member since it was planned")
    } else if (end.role === "owner" && (await countActiveOwners(end.workspaceId, session)) <= 1) {
      // Planned as one of several owners, and the others have gone since: stale.
      throw new WorkspaceError("membership_changed", 409, "the workspace's owners changed since it was planned")
    }
    await endMembership(session, {
      workspace: updated,
      actor: SYSTEM,
      membership,
      reason: "removed",
      action: "membership.removed",
    })
  })
}

/** Workspaces among `workspaceIds` that are active and have no Owner now. */
async function ownerlessAmong(workspaceIds: Iterable<string>): Promise<string[]> {
  const out: string[] = []
  for (const workspaceId of new Set(workspaceIds)) {
    const workspace = await WorkspaceModel.findOne({workspaceId}).lean<WorkspaceRow>()
    if (!workspace || workspace.status !== "active") continue
    if ((await countActiveOwners(workspaceId)) === 0) out.push(workspaceId)
  }
  return out.sort()
}

export async function cleanupOneWorkspacePerPerson(options: CleanupOptions): Promise<CleanupReport> {
  const log = options.log ?? (() => {})
  const report: CleanupReport = {apply: options.apply, people: [], ownerless: [], guardsWritten: 0, gaveUp: []}
  const touched = new Set<string>()
  const wouldBeOwnerless = new Set<string>()

  for (const mentraUserId of await peopleWithSeveral()) {
    let plan = await planPerson(mentraUserId, null)
    if (!plan) continue
    if (!options.apply) {
      report.people.push(plan)
      for (const end of plan.ended) {
        if (end.soleMember) wouldBeOwnerless.add(end.workspaceId)
      }
      continue
    }

    let done = false
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && plan && !done; attempt++) {
      try {
        for (const end of plan.ended) {
          await applyEnd(plan, end)
          touched.add(end.workspaceId)
          log(`ended ${end.membershipId} (${end.role}) of ${mentraUserId} in ${end.workspaceId}`)
        }
        done = true
      } catch (error) {
        if (!(error instanceof WorkspaceError) || error.code !== "membership_changed") throw error
        log(`${mentraUserId}: a membership changed while ending another; planning again (attempt ${attempt})`)
        plan = await planPerson(mentraUserId, null)
      }
    }
    if (!done) {
      report.gaveUp.push(mentraUserId)
      continue
    }
    const after = plan!
    // Left with one membership: write their guard for it. A person with a blocked membership still has several.
    if (after.blocked.length === 0) {
      await withTransaction(session => setGuard(session, mentraUserId, after.kept))
    }
    report.people.push(after)
  }

  if (options.apply) {
    report.guardsWritten = await initializeGuards()
    report.ownerless = await ownerlessAmong(touched)
  } else {
    report.ownerless = [...wouldBeOwnerless].sort()
  }
  return report
}

// --- Command line ----------------------------------------------------------

const USAGE = `Usage: bun packages/core/scripts/one-workspace-cleanup.ts --target <mongo-url> [--apply] [--i-understand-remote]

Without --apply the script prints a JSON report and writes nothing. --apply refuses unless the URL is local;
--i-understand-remote lifts that and is for the operator only.`

export function parseArgs(argv: string[]): {target: string; apply: boolean; allowRemote: boolean} {
  let target: string | undefined
  let apply = false
  let allowRemote = false
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    const equals = token.indexOf("=")
    const flag = token.startsWith("--") && equals !== -1 ? token.slice(0, equals) : token
    const inline = token.startsWith("--") && equals !== -1 ? token.slice(equals + 1) : undefined
    if (flag === "--target") {
      const value = inline ?? argv[++i]
      if (value === undefined || (inline === undefined && value.startsWith("--"))) throw new UsageError("--target needs a value")
      if (target !== undefined) throw new UsageError("--target was given more than once")
      target = value
    } else if (flag === "--apply" && inline === undefined) apply = true
    else if (flag === "--i-understand-remote" && inline === undefined) allowRemote = true
    else throw new UsageError(`unknown argument ${token}`)
  }
  if (target === undefined) throw new UsageError("--target is required")
  if (!splitMongoUrl(target)) throw new UsageError("--target must be a mongodb:// or mongodb+srv:// URL")
  if (apply && !allowRemote && !isLocalMongoUrl(target)) {
    throw new UsageError(
      "--apply refuses a non-local --target: it must be mongodb:// on 127.0.0.1, localhost or [::1] without " +
        "credentials. Operators can pass --i-understand-remote.",
    )
  }
  return {target, apply, allowRemote}
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.error(USAGE)
    return
  }
  let options: ReturnType<typeof parseArgs>
  try {
    options = parseArgs(argv)
  } catch (err) {
    console.error(`error: ${(err as Error).message}`)
    if (err instanceof UsageError) console.error(`\n${USAGE}`)
    process.exitCode = 2
    return
  }
  if (options.apply && options.allowRemote) {
    console.error("warning: --i-understand-remote is set; --apply may write to a non-local database")
  }
  try {
    await mongoose.connect(options.target, {serverSelectionTimeoutMS: 10_000, autoIndex: false, autoCreate: false})
    const report = await cleanupOneWorkspacePerPerson({apply: options.apply, log: message => console.error(message)})
    console.log(JSON.stringify(report, null, 2))
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  } finally {
    await mongoose.disconnect()
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2))
}
