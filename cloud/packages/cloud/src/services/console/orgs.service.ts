/**
 * services/console/org.service.ts
 *
 * Stateless console services for organization operations.
 * These functions do not modify legacy routes/services and are designed
 * to back the new /api/console/orgs endpoints.
 *
 * Responsibilities:
 * - Resolve user by email
 * - Use Organization model directly (no legacy OrganizationService)
 * - Throw typed ApiError for handlers to map to HTTP responses
 */

import { Types } from "mongoose";
import { User, UserI } from "../../models/user.model";
import Organization, { OrganizationI } from "../../models/organization.model";
import { logger as rootLogger } from "../logging/pino-logger";
const logger = rootLogger.child({ service: "orgs.service" });

/**
 * Typed service-layer error that carries an HTTP status code.
 * Route handlers should map this to res.status(err.statusCode).
 */
export class ApiError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.name = "ApiError";
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

/**
 * Locate (or create) the user record for a console email.
 * Throws ApiError(401/500) when appropriate.
 */
async function getOrCreateUserByEmail(email: string): Promise<UserI> {
  if (!email || typeof email !== "string") {
    throw new ApiError(400, "Missing or invalid email");
  }
  const normalized = email.toLowerCase();
  try {
    return await User.findOrCreateUser(normalized);
  } catch (error: unknown) {
    const _logger = logger.child({
      userId: email,
      method: "getOrCreateUserByEmail",
    });
    _logger.error(error, "Failed to resolve user");
    throw new ApiError(500, "Failed to resolve user");
  }
}

/**
 * Helpers
 */
function toObjectId(id: string, label = "id"): Types.ObjectId {
  try {
    return new Types.ObjectId(id);
  } catch {
    throw new ApiError(400, `Invalid ${label}`);
  }
}

async function ensureMember(user: UserI, orgId: string) {
  const org = await Organization.findById(orgId);
  if (!org) throw new ApiError(404, "Organization not found");
  const isMember = org.members.some(
    (m) => m.user.toString() === user._id.toString(),
  );
  if (!isMember) throw new ApiError(403, "Insufficient permissions");
  return org;
}

async function ensureAdmin(user: UserI, orgId: string) {
  const org = await Organization.findById(orgId);
  if (!org) throw new ApiError(404, "Organization not found");
  const isAdmin = org.members.some(
    (m) => m.user.toString() === user._id.toString() && m.role === "admin",
  );
  if (!isAdmin) throw new ApiError(403, "Insufficient permissions");
  return org;
}

/**
 * List all organizations for the authenticated console user.
 */
export async function listUserOrgs(email: string): Promise<OrganizationI[]> {
  const user = await getOrCreateUserByEmail(email);
  try {
    return await Organization.find({ "members.user": user._id }).exec();
  } catch {
    throw new ApiError(500, "Failed to list organizations");
  }
}

/**
 * Create a new organization for the authenticated user.
 * - Generates a slug from the name.
 * - Adds creator as admin member.
 * - Sets contactEmail = user.email in profile.
 */
export async function createOrg(
  email: string,
  name: string,
): Promise<OrganizationI> {
  const user = await getOrCreateUserByEmail(email);

  const trimmed =
    typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
  if (!trimmed) {
    throw new ApiError(400, "Organization name is required");
  }

  const slug = Organization.generateSlug(trimmed);
  const orgDoc = new Organization({
    name: trimmed,
    slug,
    profile: {
      contactEmail: user.email,
    },
    members: [{ user: user._id, role: "admin", joinedAt: new Date() }],
    pendingInvites: [],
  });

  try {
    await orgDoc.save();
    return orgDoc;
  } catch (error: unknown) {
    const _logger = logger.child({
      userId: email,
      method: "createOrg",
    });
    _logger.error(error, "Failed to create organization");
    throw new ApiError(500, "Failed to create organization");
  }
}

/**
 * Get a specific organization by ID (must be a member).
 */
export async function getOrg(
  email: string,
  orgId: string,
): Promise<OrganizationI> {
  if (!orgId) throw new ApiError(400, "Organization ID is required");
  const user = await getOrCreateUserByEmail(email);
  const org = await ensureMember(user, orgId);
  return org;
}

/**
 * Update an organization (admin only).
 * - Allows updating name and profile (website/contactEmail/description/logo).
 * - Recomputes slug if name changes.
 */
export async function updateOrg(
  email: string,
  orgId: string,
  patch: Partial<Pick<OrganizationI, "name" | "profile">>,
): Promise<OrganizationI> {
  if (!orgId) throw new ApiError(400, "Organization ID is required");
  const user = await getOrCreateUserByEmail(email);
  const org = await ensureAdmin(user, orgId);

  const updates: any = {};
  if (patch.name && typeof patch.name === "string") {
    updates.name = patch.name.trim().replace(/\s+/g, " ");
    updates.slug = Organization.generateSlug(updates.name);
  }
  if (patch.profile && typeof patch.profile === "object") {
    updates.profile = {
      ...org.profile,
      ...patch.profile,
    };
  }

  try {
    const updated = await Organization.findByIdAndUpdate(
      org._id,
      { $set: updates },
      { new: true, runValidators: true },
    );
    if (!updated) throw new ApiError(404, "Organization not found");
    return updated;
  } catch {
    throw new ApiError(500, "Failed to update organization");
  }
}

/**
 * Delete an organization (admin only).
 */
export async function deleteOrg(email: string, orgId: string): Promise<void> {
  if (!orgId) throw new ApiError(400, "Organization ID is required");
  const user = await getOrCreateUserByEmail(email);
  await ensureAdmin(user, orgId);

  try {
    await Organization.deleteOne({ _id: toObjectId(orgId, "orgId") });
  } catch {
    throw new ApiError(500, "Failed to delete organization");
  }
}

/**
 * Invite a member to the organization (admin only).
 * - Generates a token (opaque random or JWT is fine later) and appends to pendingInvites.
 * - Returns { token } (caller may email separately).
 */
export async function inviteMember(
  email: string,
  orgId: string,
  inviteeEmail: string,
  role: "admin" | "member" = "member",
): Promise<{ token: string }> {
  if (!orgId) throw new ApiError(400, "Organization ID is required");
  if (!inviteeEmail) throw new ApiError(400, "Invitee email is required");
  const user = await getOrCreateUserByEmail(email);
  const org = await ensureAdmin(user, orgId);

  const lower = inviteeEmail.toLowerCase().trim();
  const token = `${org._id.toString()}.${Date.now()}.${Math.random().toString(36).slice(2)}`;

  // Remove any existing pending invite for the same email
  org.pendingInvites = (org.pendingInvites || []).filter(
    (i) => i.email !== lower,
  );

  org.pendingInvites.push({
    email: lower,
    role,
    token,
    invitedBy: user._id as Types.ObjectId,
    invitedAt: new Date(),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7), // 7 days
    emailSentCount: 1,
    lastEmailSentAt: new Date(),
  });

  await org.save();
  return { token };
}

/**
 * Resend an invitation email (admin only).
 * - Increments emailSentCount and updates lastEmailSentAt.
 */
export async function resendInvite(
  email: string,
  orgId: string,
  inviteeEmail: string,
): Promise<void> {
  if (!orgId) throw new ApiError(400, "Organization ID is required");
  if (!inviteeEmail) throw new ApiError(400, "Invitee email is required");
  const user = await getOrCreateUserByEmail(email);
  const org = await ensureAdmin(user, orgId);

  const lower = inviteeEmail.toLowerCase().trim();
  const invite = (org.pendingInvites || []).find((i) => i.email === lower);
  if (!invite) throw new ApiError(404, "Invite not found");

  invite.emailSentCount = (invite.emailSentCount || 0) + 1;
  invite.lastEmailSentAt = new Date();

  await org.save();
}

/**
 * Rescind (cancel) a pending invitation (admin only).
 */
export async function rescindInvite(
  email: string,
  orgId: string,
  inviteeEmail: string,
): Promise<void> {
  if (!orgId) throw new ApiError(400, "Organization ID is required");
  if (!inviteeEmail) throw new ApiError(400, "Invitee email is required");
  const user = await getOrCreateUserByEmail(email);
  const org = await ensureAdmin(user, orgId);

  const lower = inviteeEmail.toLowerCase().trim();
  const before = org.pendingInvites.length;
  org.pendingInvites = (org.pendingInvites || []).filter(
    (i) => i.email !== lower,
  );
  if (before === org.pendingInvites.length) {
    throw new ApiError(404, "Invite not found");
  }
  await org.save();
}

/**
 * Accept an invitation token to join an organization.
 * - Adds user as member with the role embedded in the invite.
 * - Removes the pending invite.
 */
export async function acceptInvite(
  email: string,
  token: string,
): Promise<OrganizationI> {
  if (!token) throw new ApiError(400, "Invite token is required");
  const user = await getOrCreateUserByEmail(email);

  // Find org by invite token
  const org = await Organization.findOne({
    "pendingInvites.token": token,
  });
  if (!org) throw new ApiError(404, "Invitation not found");

  const invite = org.pendingInvites.find((i) => i.token === token);
  if (!invite) throw new ApiError(404, "Invitation not found");

  // If already a member, just drop invite
  const alreadyMember = org.members.some(
    (m) => m.user.toString() === user._id.toString(),
  );
  if (!alreadyMember) {
    org.members.push({
      user: user._id as Types.ObjectId,
      role: invite.role,
      joinedAt: new Date(),
    });
  }

  // Remove the invite
  org.pendingInvites = org.pendingInvites.filter((i) => i.token !== token);

  await org.save();
  return org;
}

/**
 * Change a member's role (admin only).
 */
export async function changeMemberRole(
  email: string,
  orgId: string,
  memberId: string,
  role: "admin" | "member",
): Promise<OrganizationI> {
  if (!orgId || !memberId) {
    throw new ApiError(400, "orgId and memberId are required");
  }
  if (role !== "admin" && role !== "member") {
    throw new ApiError(400, "role must be 'admin' or 'member'");
  }
  const user = await getOrCreateUserByEmail(email);
  const org = await ensureAdmin(user, orgId);

  const member = org.members.find((m) => m.user.toString() === memberId);
  if (!member) throw new ApiError(404, "Member not found");

  member.role = role;
  await org.save();
  return org;
}

/**
 * Remove a member from the organization (admin only).
 */
export async function removeMember(
  email: string,
  orgId: string,
  memberId: string,
): Promise<void> {
  if (!orgId || !memberId) {
    throw new ApiError(400, "orgId and memberId are required");
  }
  const user = await getOrCreateUserByEmail(email);
  const org = await ensureAdmin(user, orgId);

  const before = org.members.length;
  org.members = org.members.filter((m) => m.user.toString() !== memberId);
  if (before === org.members.length) {
    throw new ApiError(404, "Member not found");
  }
  await org.save();
}
