import mongoose from "mongoose"
import {createLogger} from "@mentra/cloud-shared"
import {WorkOS} from "@workos-inc/node"
import {DeveloperOrgInvitationModel} from "../models/developer-org-invitation.model"
import {DeveloperOrgMembershipModel} from "../models/developer-org-membership.model"
import {DeveloperOrgModel} from "../models/developer-org.model"
import {MiniAppAccessInvitationModel} from "../models/miniapp-access-invitation.model"
import {MiniAppBetaInvitationModel} from "../models/miniapp-beta-invitation.model"
import {MiniAppReleaseModel} from "../models/miniapp-release.model"
import {MiniAppTrackEnrollmentModel} from "../models/miniapp-track-enrollment.model"
import {MiniAppModel} from "../models/miniapp.model"

const logger = createLogger("store").child({component: "startup-migrations"})
const MEMBERSHIPS = "developer_org_memberships"
const ORGS = "developer_orgs"
const INVITATIONS = "developer_org_invitations"

export async function runStartupMigrations(): Promise<void> {
  await MiniAppReleaseModel.collection.updateMany({releaseTrack: {$exists: false}}, {$set: {releaseTrack: "stable"}})
  await MiniAppModel.collection.updateMany({betaAccessMode: {$exists: false}}, {$set: {betaAccessMode: "private"}})
  await MiniAppModel.collection.updateMany({visibility: {$exists: false}}, {$set: {visibility: "public"}})
  await MiniAppReleaseModel.collection.updateMany({status: "published", publicStoreApprovedAt: {$exists: false}}, [
    {$set: {publicStoreApprovedAt: {$ifNull: ["$reviewedAt", "$publishedAt"]}}},
  ])
  await MiniAppReleaseModel.createIndexes()
  await MiniAppBetaInvitationModel.createIndexes()
  await MiniAppAccessInvitationModel.createIndexes()
  await MiniAppTrackEnrollmentModel.createIndexes()
  await migrateDeveloperOrganizationIndexes()
}

async function migrateDeveloperOrganizationIndexes(): Promise<void> {
  await dropIndexIfPresent(MEMBERSHIPS, "orgId_1_email_1")
  await dropIndexIfPresent(MEMBERSHIPS, "userId_1", (index) => index.unique === true)
  await dedupeMemberships()
  await safeCreateMembershipIndexes()
  await dropIndexIfPresent(INVITATIONS, "orgId_1_email_1", (index) => !index.partialFilterExpression)
  await DeveloperOrgInvitationModel.createIndexes()
  const orgs = await DeveloperOrgModel.find({}, {orgId: 1, ownerUserId: 1}).lean()
  for (const org of orgs) {
    if (!org.orgId || !org.ownerUserId) continue
    const owners = await DeveloperOrgMembershipModel.countDocuments({orgId: org.orgId, role: "owner"})
    if (owners > 0) continue
    await DeveloperOrgMembershipModel.updateOne(
      {orgId: org.orgId, userId: org.ownerUserId},
      {$set: {role: "owner"}, $setOnInsert: {orgId: org.orgId, userId: org.ownerUserId}},
      {upsert: true},
    )
  }
  await backfillMembersFromWorkos()
}

/**
 * Membership ownership moved from WorkOS into the Store database. Seed the
 * existing roster exactly once per organization while preserving Store-owned
 * roles. The completion marker is written only after every WorkOS page succeeds
 * so an interrupted migration safely retries on the next Store boot.
 */
async function backfillMembersFromWorkos(): Promise<void> {
  const apiKey = process.env.WORKOS_API_KEY
  if (!apiKey) return
  const workos = new WorkOS(apiKey)
  const orgsCollection = mongoose.connection.collection(ORGS)
  const orgs = await orgsCollection
    .find(
      {workosOrgId: {$type: "string"}, membersMigratedAt: {$exists: false}},
      {projection: {orgId: 1, workosOrgId: 1}},
    )
    .toArray()

  let seeded = 0
  for (const org of orgs) {
    const orgId = org.orgId as string
    const workosOrgId = org.workosOrgId as string
    try {
      let after: string | undefined
      do {
        const page = await workos.userManagement.listOrganizationMemberships({
          organizationId: workosOrgId,
          statuses: ["active", "inactive"],
          limit: 100,
          after,
        })
        for (const membership of page.data) {
          let email: string | null = null
          let name: string | null = null
          try {
            const user = await workos.userManagement.getUser(membership.userId)
            email = user.email ?? null
            name = [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email || null
          } catch {
            // Profile enrichment is best-effort; the WorkOS user id is enough
            // to preserve membership authorization.
          }
          await DeveloperOrgMembershipModel.updateOne(
            {orgId, userId: membership.userId},
            {
              $set: {...(email ? {email} : {}), ...(name ? {name} : {})},
              $setOnInsert: {orgId, userId: membership.userId, role: "member"},
            },
            {upsert: true},
          )
          seeded += 1
        }
        after = page.listMetadata?.after ?? undefined
      } while (after)
      await orgsCollection.updateOne({orgId}, {$set: {membersMigratedAt: new Date()}})
    } catch (error) {
      logger.warn({orgId, error: (error as Error)?.message}, "Store member backfill failed for org")
    }
  }
  if (seeded > 0) logger.info({seeded}, "backfilled Store organization members from WorkOS")
}

async function safeCreateMembershipIndexes(): Promise<void> {
  try {
    await DeveloperOrgMembershipModel.createIndexes()
  } catch (error) {
    logger.error(
      {collection: MEMBERSHIPS, error: (error as Error)?.message},
      "failed to create Store organization membership indexes",
    )
  }
}

async function dropIndexIfPresent(
  collectionName: string,
  name: string,
  predicate: (index: {unique?: boolean; partialFilterExpression?: unknown}) => boolean = () => true,
): Promise<void> {
  const collection = mongoose.connection.collection(collectionName)
  try {
    const index = (await collection.indexes()).find((candidate) => candidate.name === name)
    if (index && predicate(index)) {
      await collection.dropIndex(name)
      logger.info({collection: collectionName, index: name}, "dropped legacy Store index")
    }
  } catch {
    // A fresh Store database may not have the collection yet.
  }
}

async function dedupeMemberships(): Promise<void> {
  const collection = mongoose.connection.collection(MEMBERSHIPS)
  let groups: Array<{docs?: Array<{id: mongoose.Types.ObjectId; role: string}>}>
  try {
    groups = (await collection
      .aggregate([
        {$match: {orgId: {$type: "string"}, userId: {$type: "string"}}},
        {
          $group: {
            _id: {orgId: "$orgId", userId: "$userId"},
            docs: {$push: {id: "$_id", role: "$role"}},
            count: {$sum: 1},
          },
        },
        {$match: {count: {$gt: 1}}},
      ])
      .toArray()) as typeof groups
  } catch {
    return
  }
  const rank: Record<string, number> = {owner: 3, admin: 2, member: 1}
  for (const group of groups) {
    const losers = [...(group.docs ?? [])]
      .sort((a, b) => (rank[b.role] ?? 0) - (rank[a.role] ?? 0))
      .slice(1)
      .map((row) => row.id)
    if (losers.length) await collection.deleteMany({_id: {$in: losers}})
  }
}
