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

export interface DeveloperOrgMemberRecord {
  userId: string;
  email: string | null;
  name: string | null;
  role: DeveloperOrgRole;
  status: string;
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

  async getOrgById(orgId: string): Promise<DeveloperOrgRecord | null> {
    const org = await DeveloperOrgModel.findOne({ orgId }).lean();
    return org ? serializeDeveloperOrg(org) : null;
  }

  /** Create the caller's first org (onboarding) and seed them as its owner. */
  async createPrimaryOrg(user: ConsoleUserIdentity, input: UpsertDeveloperOrgInput): Promise<DeveloperOrgRecord> {
    const displayName = normalizeDisplayName(input.displayName);
    const packagePrefix = normalizePackagePrefix(input.packagePrefix);
    assertUsablePackagePrefix(packagePrefix, user);
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

  /**
   * Update an existing org by id. The caller's authorization (owner-only) is
   * enforced at the handler; this keys on orgId, not the ownerUserId scalar, so
   * any owner can edit the org. The package-prefix usability check only runs
   * when the prefix actually changes, so editing the name doesn't trip the
   * reserved-prefix gate for a co-owner.
   */
  async updateOrg(
    orgId: string,
    user: ConsoleUserIdentity,
    input: UpsertDeveloperOrgInput,
  ): Promise<DeveloperOrgRecord> {
    const displayName = normalizeDisplayName(input.displayName);
    const packagePrefix = normalizePackagePrefix(input.packagePrefix);

    const existing = await DeveloperOrgModel.findOne({ orgId });
    if (!existing) {
      throw new DeveloperOrgServiceError("org_not_found", "developer org was not found", 404);
    }

    if (packagePrefix !== existing.packagePrefix) {
      assertUsablePackagePrefix(packagePrefix, user);
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

  async setWorkosOrgId(orgId: string, workosOrgId: string): Promise<DeveloperOrgRecord> {
    const existingWithWorkosId = await DeveloperOrgModel.findOne({ workosOrgId }).lean();
    if (existingWithWorkosId && existingWithWorkosId.orgId !== orgId) {
      throw new DeveloperOrgServiceError(
        "workos_org_taken",
        "team access is already linked to another developer org",
        409,
      );
    }

    // Caller authorization (owner role) is enforced by ensureWorkosOrgLinked;
    // key on orgId only so any owner can link, not just the ownerUserId creator.
    const org = await DeveloperOrgModel.findOne({ orgId });
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
    // Force owner via $set (not $setOnInsert): a concurrent ensureMembership
    // could insert a `member` row for the creator first, and we must still end
    // up with them as owner so the org never has zero owners.
    await DeveloperOrgMembershipModel.updateOne(
      { orgId, userId },
      { $set: { role: "owner" }, $setOnInsert: { orgId, userId } },
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

  /** Another owner's userId, for transferring the created-by/bootstrap pointer. */
  async findAnotherOwner(orgId: string, excludeUserId: string): Promise<string | null> {
    const row = await DeveloperOrgMembershipModel.findOne({
      orgId,
      role: "owner",
      userId: { $ne: excludeUserId },
    }).lean();
    return row?.userId ?? null;
  }

  /** Repoint DeveloperOrg.ownerUserId (the created-by / WorkOS-bootstrap identity). */
  async reassignCreator(orgId: string, newOwnerUserId: string): Promise<void> {
    await DeveloperOrgModel.updateOne({ orgId }, { $set: { ownerUserId: newOwnerUserId } });
  }

  /**
   * Demote an owner to a lower role, but never the last one. Write-then-verify
   * so two concurrent demotions can't both pass a count check and leave the org
   * with zero owners: apply the change, re-count, and roll back if it removed
   * the last owner. Returns false (no net change) when the user is the only owner.
   */
  async demoteOwner(orgId: string, userId: string, newRole: DeveloperOrgRole): Promise<boolean> {
    await this.setMemberRole(orgId, userId, newRole);
    if ((await this.countOwners(orgId)) === 0) {
      await this.setMemberRole(orgId, userId, "owner");
      return false;
    }
    return true;
  }

  /**
   * Remove an owner's role row, but never the last one (same write-then-verify
   * race guard as demoteOwner). Returns false (and restores the row) when the
   * user is the only owner.
   */
  async removeOwnerIfNotLast(orgId: string, userId: string): Promise<boolean> {
    const existing = await DeveloperOrgMembershipModel.findOne({ orgId, userId }).lean<
      { email?: string | null; name?: string | null; status?: string | null } | null
    >();
    await this.removeMemberRole(orgId, userId);
    if ((await this.countOwners(orgId)) === 0) {
      // Restore the full row (profile fields included), not just the role.
      await DeveloperOrgMembershipModel.updateOne(
        { orgId, userId },
        {
          $set: {
            role: "owner",
            email: existing?.email ?? null,
            name: existing?.name ?? null,
            status: existing?.status ?? "active",
          },
          $setOnInsert: { orgId, userId },
        },
        { upsert: true },
      );
      return false;
    }
    return true;
  }

  /** Roles for every member of an org, keyed by WorkOS userId. */
  async listMemberRoles(orgId: string): Promise<Map<string, DeveloperOrgRole>> {
    const rows = await DeveloperOrgMembershipModel.find({ orgId }).lean();
    return new Map(rows.map(row => [row.userId, row.role as DeveloperOrgRole]));
  }

  /**
   * Ensure a membership row exists for a user and backfill profile fields.
   * Role is only set on insert, so this never downgrades an existing owner/admin.
   */
  async ensureMembership(
    orgId: string,
    userId: string,
    opts: { email?: string | null; name?: string | null; roleIfNew?: DeveloperOrgRole } = {},
  ): Promise<void> {
    if (!userId) return;
    const set: Record<string, unknown> = {};
    if (opts.email) set.email = opts.email.trim().toLowerCase();
    if (opts.name) set.name = opts.name;
    await DeveloperOrgMembershipModel.updateOne(
      { orgId, userId },
      {
        ...(Object.keys(set).length ? { $set: set } : {}),
        $setOnInsert: { orgId, userId, role: opts.roleIfNew ?? "member" },
      },
      { upsert: true },
    );
  }

  /** The orgId a user belongs to via a membership row (one org per user). */
  async getMembershipOrgId(userId: string): Promise<string | null> {
    if (!userId) return null;
    const row = await DeveloperOrgMembershipModel.findOne({ userId }).sort({ createdAt: 1 }).lean();
    return row?.orgId ?? null;
  }

  /** Full roster of an org, for the member list. */
  async listMembers(orgId: string): Promise<DeveloperOrgMemberRecord[]> {
    const rows = await DeveloperOrgMembershipModel.find({ orgId })
      .sort({ createdAt: 1 })
      .lean<
        Array<{
          userId: string;
          email?: string | null;
          name?: string | null;
          role: string;
          status?: string | null;
          createdAt?: Date;
          updatedAt?: Date;
        }>
      >();
    return rows.map(row => ({
      userId: row.userId,
      email: row.email ?? null,
      name: row.name ?? null,
      role: row.role as DeveloperOrgRole,
      status: row.status ?? "active",
      createdAt: row.createdAt?.toISOString() ?? null,
      updatedAt: row.updatedAt?.toISOString() ?? null,
    }));
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
