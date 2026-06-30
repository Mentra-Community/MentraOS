import { ulid } from "ulid";
import { DeveloperOrgModel, type DeveloperOrgPrefixStatus } from "../../models/developer-org.model";
import {
  DeveloperOrgMembershipModel,
  type DeveloperOrgRole,
} from "../../models/developer-org-membership.model";
import { MiniAppModel } from "../../models/miniapp.model";

export type { DeveloperOrgRole } from "../../models/developer-org-membership.model";

export interface ConsoleUserIdentity {
  id: string;
  email: string;
}

export interface DeveloperOrgRecord {
  id: string;
  ownerUserId: string;
  workosOrgId: string | null;
  name: string;
  packagePrefix: string;
  packagePrefixStatus: DeveloperOrgPrefixStatus;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface UpsertDeveloperOrgInput {
  displayName: string;
  packagePrefix: string;
  workosOrgId?: string | null;
}

export class DeveloperOrgService {
  async getPrimaryOrgForUser(user: ConsoleUserIdentity): Promise<DeveloperOrgRecord | null> {
    const org = await DeveloperOrgModel.findOne({ ownerUserId: user.id })
      .sort({ createdAt: 1 })
      .lean();
    return org ? serializeDeveloperOrg(org) : null;
  }

  async getOrgByWorkosOrgId(workosOrgId: string): Promise<DeveloperOrgRecord | null> {
    const org = await DeveloperOrgModel.findOne({ workosOrgId }).lean();
    return org ? serializeDeveloperOrg(org) : null;
  }

  async upsertPrimaryOrg(user: ConsoleUserIdentity, input: UpsertDeveloperOrgInput): Promise<DeveloperOrgRecord> {
    const displayName = normalizeDisplayName(input.displayName);
    const packagePrefix = normalizePackagePrefix(input.packagePrefix);
    assertUsablePackagePrefix(packagePrefix, user);

    const existing = await DeveloperOrgModel.findOne({ ownerUserId: user.id }).sort({ createdAt: 1 });
    if (!existing) {
      await assertPackagePrefixAvailable(packagePrefix);
      const created = await DeveloperOrgModel.create({
        orgId: `dorg_${ulid()}`,
        ownerUserId: user.id,
        workosOrgId: input.workosOrgId || undefined,
        displayName,
        packagePrefix,
        packagePrefixStatus: packagePrefix === "com.mentra" ? "verified" : "unverified",
      });
      // Seed the creator as the org's first owner. From here, ownership is a
      // membership role (owner|admin|member), not the ownerUserId scalar.
      await this.ensureOwner(created.orgId, user.id);
      return serializeDeveloperOrg(created.toObject());
    }

    const nextPrefix = existing.packagePrefix;
    if (packagePrefix !== nextPrefix) {
      if (existing.packagePrefixStatus !== "rejected") {
        throw new DeveloperOrgServiceError(
          "package_prefix_locked",
          "package prefix cannot change after organization creation unless the current prefix was rejected",
          409,
        );
      }
      await assertPackagePrefixAvailable(packagePrefix);
      if (await hasActiveMiniApps(existing.orgId)) {
        throw new DeveloperOrgServiceError(
          "package_prefix_locked",
          "package prefix cannot change after miniapps have been created",
          409,
        );
      }
      existing.packagePrefix = packagePrefix;
      existing.packagePrefixStatus = packagePrefix === "com.mentra" ? "verified" : "unverified";
    }

    existing.displayName = displayName;
    if (!existing.workosOrgId && input.workosOrgId) {
      existing.workosOrgId = input.workosOrgId;
    }
    await existing.save();
    return serializeDeveloperOrg(existing.toObject());
  }

  async setWorkosOrgId(user: ConsoleUserIdentity, orgId: string, workosOrgId: string): Promise<DeveloperOrgRecord> {
    const existingWithWorkosId = await DeveloperOrgModel.findOne({ workosOrgId }).lean();
    if (existingWithWorkosId && existingWithWorkosId.orgId !== orgId) {
      throw new DeveloperOrgServiceError(
        "workos_org_taken",
        "team access is already linked to another developer org",
        409,
      );
    }

    const org = await DeveloperOrgModel.findOne({ orgId, ownerUserId: user.id });
    if (!org) {
      throw new DeveloperOrgServiceError("org_not_found", "developer org was not found", 404);
    }
    org.workosOrgId = workosOrgId;
    await org.save();
    return serializeDeveloperOrg(org.toObject());
  }

  /**
   * The role a user holds in an org (owner | admin | member), or null when they
   * have no row (which resolves to `member`). Keyed by WorkOS userId.
   */
  async getMemberRole(orgId: string, userId: string | null | undefined): Promise<DeveloperOrgRole | null> {
    if (!userId) return null;
    const row = await DeveloperOrgMembershipModel.findOne({ orgId, userId }).lean();
    return row ? (row.role as DeveloperOrgRole) : null;
  }

  /** Set/overwrite a user's role in an org. */
  async setMemberRole(orgId: string, userId: string, role: DeveloperOrgRole): Promise<void> {
    if (!userId) return;
    await DeveloperOrgMembershipModel.updateOne(
      { orgId, userId },
      { $set: { role }, $setOnInsert: { orgId, userId } },
      { upsert: true },
    );
  }

  /** Idempotently make a user an owner (used to seed the org creator). */
  async ensureOwner(orgId: string, userId: string): Promise<void> {
    if (!userId) return;
    await DeveloperOrgMembershipModel.updateOne(
      { orgId, userId },
      { $setOnInsert: { orgId, userId, role: "owner" } },
      { upsert: true },
    );
  }

  /** Remove a user's role row (on removal from the org). */
  async removeMemberRole(orgId: string, userId: string): Promise<void> {
    if (!userId) return;
    await DeveloperOrgMembershipModel.deleteOne({ orgId, userId });
  }

  /** Number of owners in an org. Used to enforce "at least one owner remains". */
  async countOwners(orgId: string): Promise<number> {
    return DeveloperOrgMembershipModel.countDocuments({ orgId, role: "owner" });
  }

  /** Roles for every member of an org, keyed by WorkOS userId. */
  async listMemberRoles(orgId: string): Promise<Map<string, DeveloperOrgRole>> {
    const rows = await DeveloperOrgMembershipModel.find({ orgId }).lean();
    return new Map(rows.map(row => [row.userId, row.role as DeveloperOrgRole]));
  }
}

export class DeveloperOrgServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DeveloperOrgServiceError";
  }
}

function normalizeDisplayName(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < 2) {
    throw new DeveloperOrgServiceError("invalid_org_name", "organization name must be at least 2 characters", 400);
  }
  if (normalized.length > 80) {
    throw new DeveloperOrgServiceError("invalid_org_name", "organization name must be 80 characters or fewer", 400);
  }
  return normalized;
}

function normalizePackagePrefix(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.+$/, "");
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(normalized)) {
    throw new DeveloperOrgServiceError(
      "invalid_package_prefix",
      "package prefix must be lowercase reverse-DNS text, for example io.acme",
      400,
    );
  }
  return normalized;
}

function assertUsablePackagePrefix(prefix: string, user: ConsoleUserIdentity): void {
  if (reservedPackagePrefixes().includes(prefix) && !canClaimReservedPrefix(prefix, user)) {
    throw new DeveloperOrgServiceError(
      "reserved_package_prefix",
      `${prefix} is reserved and cannot be claimed by this account`,
      409,
    );
  }
}

async function assertPackagePrefixAvailable(packagePrefix: string): Promise<void> {
  const existing = await DeveloperOrgModel.findOne({ packagePrefix }).lean();
  if (existing) {
    throw new DeveloperOrgServiceError(
      "package_prefix_taken",
      `${packagePrefix} is already claimed by another developer org`,
      409,
    );
  }
}

async function hasActiveMiniApps(orgId: string): Promise<boolean> {
  const appCount = await MiniAppModel.countDocuments({ orgId, status: { $ne: "archived" } });
  return appCount > 0;
}

function reservedPackagePrefixes(): string[] {
  const raw = process.env.CLOUD_CORE_RESERVED_PACKAGE_PREFIXES;
  const defaults = "com.mentra,com.google,com.apple,com.microsoft,com.meta,com.facebook,com.amazon";
  return (raw || defaults)
    .split(",")
    .map(prefix => prefix.trim().toLowerCase().replace(/\.+$/, ""))
    .filter(Boolean);
}

function canClaimReservedPrefix(prefix: string, user: ConsoleUserIdentity): boolean {
  if (prefix !== "com.mentra") return false;
  return user.email.toLowerCase().endsWith("@mentraglass.com");
}

function serializeDeveloperOrg(org: {
  orgId: string;
  ownerUserId: string;
  workosOrgId?: string | null;
  displayName: string;
  packagePrefix: string;
  packagePrefixStatus: DeveloperOrgPrefixStatus;
  createdAt?: Date;
  updatedAt?: Date;
}): DeveloperOrgRecord {
  return {
    id: org.orgId,
    ownerUserId: org.ownerUserId,
    workosOrgId: org.workosOrgId ?? null,
    name: org.displayName,
    packagePrefix: org.packagePrefix,
    packagePrefixStatus: org.packagePrefixStatus,
    createdAt: org.createdAt?.toISOString() ?? null,
    updatedAt: org.updatedAt?.toISOString() ?? null,
  };
}
