import {ulid} from "ulid"
import {MiniAppAccessInvitationModel} from "../../models/miniapp-access-invitation.model"
import {MiniAppModel} from "../../models/miniapp.model"
import {resolveMentraUserByEmail} from "../core-identity.client"
import type {DeveloperIdentity} from "./miniapp.service"

export interface MiniAppAccessInvitationRecord {
  id: string
  email: string
  state: "pending" | "accepted" | "revoked"
  expiresAt: string | null
  acceptedAt: string | null
  createdAt: string | null
  updatedAt: string | null
}

const INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000

export type ResolveMentraUserByEmail = (email: string) => Promise<string | null>

export class MiniAppAccessService {
  constructor(private readonly resolveUser: ResolveMentraUserByEmail = resolveMentraUserByEmail) {}

  async getAccess(developer: DeveloperIdentity, packageName: string) {
    const app = await this.requireApp(developer, packageName)
    const invitations = await MiniAppAccessInvitationModel.find({
      miniAppId: app._id.toString(),
      $or: [{status: "accepted"}, {status: "pending", expiresAt: {$gt: new Date()}}],
    })
      .sort({createdAt: -1})
      .lean()
    return {
      visibility: app.visibility === "private" ? "private" : "public",
      invitations: invitations.map(serializeInvitation),
    }
  }

  async invite(developer: DeveloperIdentity, packageName: string, email: string) {
    const app = await this.requireApp(developer, packageName)
    const normalizedEmail = email.trim().toLowerCase()
    const mentraUserId = await this.resolveUser(normalizedEmail)
    if (!mentraUserId) {
      throw new MiniAppAccessServiceError(
        "mentra_user_not_found",
        "A verified Mentra account with this email must exist before it can access a private miniapp",
        404,
      )
    }
    const common = {
      orgId: developer.orgId,
      packageName: app.packageName,
      email: normalizedEmail,
      mentraUserId,
      invitedByUserId: developer.developerId,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    }
    const selector = {miniAppId: app._id.toString(), $or: [{email: normalizedEmail}, {mentraUserId}]}
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const matches = await MiniAppAccessInvitationModel.find(selector).select("_id email mentraUserId").lean()
      const emailMatch = matches.find((invitation) => invitation.email === normalizedEmail)
      const identityMatch = matches.find((invitation) => invitation.mentraUserId === mentraUserId)
      if (emailMatch && identityMatch && emailMatch._id.toString() !== identityMatch._id.toString()) {
        await MiniAppAccessInvitationModel.deleteOne({_id: emailMatch._id})
        continue
      }
      const now = new Date()
      const preservesAcceptedIdentity = {
        $and: [{$eq: ["$status", "accepted"]}, {$eq: ["$mentraUserId", {$literal: common.mentraUserId}]}],
      }
      try {
        const invitation = await MiniAppAccessInvitationModel.findOneAndUpdate(
          selector,
          [
            {
              $set: {
                invitationId: {$ifNull: ["$invitationId", `ainv_${ulid()}`]},
                miniAppId: app._id.toString(),
                orgId: {$literal: common.orgId},
                packageName: {$literal: common.packageName},
                email: {$literal: common.email},
                mentraUserId: {$literal: common.mentraUserId},
                invitedByUserId: {$literal: common.invitedByUserId},
                expiresAt: common.expiresAt,
                status: {$cond: [preservesAcceptedIdentity, "accepted", "pending"]},
                acceptedAt: {$cond: [preservesAcceptedIdentity, "$acceptedAt", null]},
                createdAt: {$ifNull: ["$createdAt", now]},
                updatedAt: now,
              },
            },
          ],
          {new: true, upsert: true},
        )
        if (!invitation) throw new MiniAppAccessServiceError("invite_failed", "Could not create invitation", 500)
        return serializeInvitation(invitation.toObject())
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error
      }
    }
    throw new MiniAppAccessServiceError("invite_conflict", "Invitation identity changed; retry", 409)
  }

  async revoke(developer: DeveloperIdentity, packageName: string, invitationId: string) {
    const app = await this.requireApp(developer, packageName)
    const invitation = await MiniAppAccessInvitationModel.findOneAndUpdate(
      {invitationId, miniAppId: app._id.toString(), orgId: developer.orgId, status: {$ne: "revoked"}},
      {$set: {status: "revoked"}},
      {new: true},
    )
    if (!invitation) throw new MiniAppAccessServiceError("not_found", "invitation not found", 404)
    return {ok: true}
  }

  private async requireApp(developer: DeveloperIdentity, packageName: string) {
    const app = await MiniAppModel.findOne({
      orgId: developer.orgId,
      packageName: packageName.trim().toLowerCase(),
      status: {$ne: "archived"},
    })
    if (!app) throw new MiniAppAccessServiceError("not_found", "miniapp not found", 404)
    return app
  }
}

export class MiniAppAccessServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "MiniAppAccessServiceError"
  }
}

function serializeInvitation(row: {
  invitationId: string
  email: string
  status: string
  expiresAt?: Date | null
  acceptedAt?: Date | null
  createdAt?: Date
  updatedAt?: Date
}): MiniAppAccessInvitationRecord {
  return {
    id: row.invitationId,
    email: row.email,
    state: row.status === "accepted" ? "accepted" : row.status === "revoked" ? "revoked" : "pending",
    expiresAt: row.expiresAt?.toISOString() ?? null,
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    createdAt: row.createdAt?.toISOString() ?? null,
    updatedAt: row.updatedAt?.toISOString() ?? null,
  }
}

function isDuplicateKeyError(error: unknown): error is {code: number} {
  return typeof error === "object" && error !== null && "code" in error && error.code === 11000
}
