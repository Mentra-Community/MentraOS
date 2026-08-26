import { ulid } from "ulid";
import { MiniAppBetaInvitationModel } from "../../models/miniapp-beta-invitation.model";
import { MiniAppTrackEnrollmentModel } from "../../models/miniapp-track-enrollment.model";
import { MiniAppModel } from "../../models/miniapp.model";
import { UserModel } from "../../models/user.model";
import { findUserByEmail } from "../account/gotrue.client";
import { findOrCreateUser } from "../user.service";
import type { DeveloperIdentity } from "./miniapp.service";

export type MiniAppBetaAccessMode = "private" | "public";

export interface MiniAppBetaInvitationRecord {
  id: string;
  email: string;
  state: "pending" | "accepted" | "revoked";
  expiresAt: string | null;
  acceptedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

const INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type ResolveMentraUserByEmail = (email: string) => Promise<string | null>;

async function resolveMentraUserByEmail(email: string): Promise<string | null> {
  const identity = await findUserByEmail(email);
  if (!identity?.emailVerified) return null;
  const existing = await UserModel.findOne({ tenantId: "mentra", tenantUserId: identity.id }).lean();
  if (existing) return existing.mentraUserId;
  return (await findOrCreateUser({ tenantId: "mentra", tenantUserId: identity.id })).mentraUserId;
}

export class MiniAppBetaService {
  constructor(private readonly resolveUser: ResolveMentraUserByEmail = resolveMentraUserByEmail) {}

  async getAccess(developer: DeveloperIdentity, packageName: string) {
    const app = await this.requireApp(developer, packageName);
    const invitations = await MiniAppBetaInvitationModel.find({
      miniAppId: app._id.toString(),
      $or: [
        { status: "accepted" },
        { status: "pending", expiresAt: { $gt: new Date() } },
      ],
    })
      .sort({ createdAt: -1 })
      .lean();
    return {
      mode: app.betaAccessMode === "public" ? "public" : "private",
      invitations: invitations.map(serializeInvitation),
    };
  }

  async setAccessMode(developer: DeveloperIdentity, packageName: string, mode: MiniAppBetaAccessMode) {
    const app = await this.requireApp(developer, packageName);
    app.betaAccessMode = mode;
    await app.save();

    if (mode === "private") {
      const invitedUserIds = await MiniAppBetaInvitationModel.distinct("mentraUserId", {
        miniAppId: app._id.toString(),
        status: "accepted",
      });
      await MiniAppTrackEnrollmentModel.deleteMany({
        miniAppId: app._id.toString(),
        ...(invitedUserIds.length > 0 ? { mentraUserId: { $nin: invitedUserIds } } : {}),
      });
    }
    return this.getAccess(developer, packageName);
  }

  async invite(developer: DeveloperIdentity, packageName: string, email: string) {
    const app = await this.requireApp(developer, packageName);
    const normalizedEmail = email.trim().toLowerCase();
    const mentraUserId = await this.resolveUser(normalizedEmail);
    if (!mentraUserId) {
      throw new MiniAppBetaServiceError(
        "mentra_user_not_found",
        "A verified Mentra account with this email must exist before it can join a private beta",
        404,
      );
    }
    const common = {
      orgId: developer.orgId,
      packageName: app.packageName,
      email: normalizedEmail,
      mentraUserId,
      invitedByUserId: developer.developerId,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    };
    const selector = {
      miniAppId: app._id.toString(),
      $or: [{ email: normalizedEmail }, { mentraUserId }],
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const matches = await MiniAppBetaInvitationModel.find(selector).select("_id email mentraUserId").lean();
      const emailMatch = matches.find(invitation => invitation.email === normalizedEmail);
      const identityMatch = matches.find(invitation => invitation.mentraUserId === mentraUserId);
      const previousMentraUserId = emailMatch?.mentraUserId;
      if (emailMatch && identityMatch && emailMatch._id.toString() !== identityMatch._id.toString()) {
        const removed = await MiniAppBetaInvitationModel.deleteOne({
          _id: emailMatch._id,
          email: normalizedEmail,
          mentraUserId: emailMatch.mentraUserId,
        });
        if (removed.deletedCount === 1 && app.betaAccessMode !== "public") {
          await MiniAppTrackEnrollmentModel.deleteOne({
            miniAppId: app._id.toString(),
            mentraUserId: emailMatch.mentraUserId,
          });
        }
        continue;
      }

      const now = new Date();
      const preservesAcceptedIdentity = {
        $and: [
          { $eq: ["$status", "accepted"] },
          { $eq: ["$mentraUserId", { $literal: common.mentraUserId }] },
        ],
      };
      try {
        const invitation = await MiniAppBetaInvitationModel.findOneAndUpdate(
          selector,
          [
            {
              $set: {
                invitationId: { $ifNull: ["$invitationId", `binv_${ulid()}`] },
                miniAppId: app._id.toString(),
                orgId: { $literal: common.orgId },
                packageName: { $literal: common.packageName },
                email: { $literal: common.email },
                mentraUserId: { $literal: common.mentraUserId },
                invitedByUserId: { $literal: common.invitedByUserId },
                expiresAt: common.expiresAt,
                status: { $cond: [preservesAcceptedIdentity, "accepted", "pending"] },
                acceptedAt: { $cond: [preservesAcceptedIdentity, "$acceptedAt", null] },
                createdAt: { $ifNull: ["$createdAt", now] },
                updatedAt: now,
              },
            },
          ],
          { new: true, upsert: true },
        );
        if (!invitation) throw new MiniAppBetaServiceError("invite_failed", "Could not create beta invitation", 500);
        if (previousMentraUserId && previousMentraUserId !== mentraUserId && app.betaAccessMode !== "public") {
          await MiniAppTrackEnrollmentModel.deleteOne({
            miniAppId: app._id.toString(),
            mentraUserId: previousMentraUserId,
          });
        }
        return serializeInvitation(invitation.toObject());
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
      }
    }
    throw new MiniAppBetaServiceError(
      "invite_conflict",
      "Beta invitation identity changed concurrently; retry the invitation",
      409,
    );
  }

  async revoke(developer: DeveloperIdentity, packageName: string, invitationId: string) {
    const app = await this.requireApp(developer, packageName);
    const invitation = await MiniAppBetaInvitationModel.findOneAndUpdate(
      { invitationId, miniAppId: app._id.toString(), orgId: developer.orgId, status: { $ne: "revoked" } },
      { $set: { status: "revoked" } },
      { new: true },
    );
    if (!invitation) throw new MiniAppBetaServiceError("not_found", "beta invitation not found", 404);
    await MiniAppTrackEnrollmentModel.deleteOne({
      miniAppId: app._id.toString(),
      mentraUserId: invitation.mentraUserId,
    });
    return { ok: true };
  }

  private async requireApp(developer: DeveloperIdentity, packageName: string) {
    const app = await MiniAppModel.findOne({
      orgId: developer.orgId,
      packageName: packageName.trim().toLowerCase(),
      status: { $ne: "archived" },
    });
    if (!app) throw new MiniAppBetaServiceError("not_found", "miniapp not found", 404);
    return app;
  }
}

export class MiniAppBetaServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MiniAppBetaServiceError";
  }
}

function serializeInvitation(row: {
  invitationId: string;
  email: string;
  status: string;
  expiresAt?: Date | null;
  acceptedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}): MiniAppBetaInvitationRecord {
  return {
    id: row.invitationId,
    email: row.email,
    state: row.status === "accepted" ? "accepted" : row.status === "revoked" ? "revoked" : "pending",
    expiresAt: row.expiresAt?.toISOString() ?? null,
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    createdAt: row.createdAt?.toISOString() ?? null,
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

function isDuplicateKeyError(error: unknown): error is { code: number } {
  return typeof error === "object" && error !== null && "code" in error && error.code === 11000;
}
