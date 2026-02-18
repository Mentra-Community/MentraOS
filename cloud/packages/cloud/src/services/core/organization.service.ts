import { Types } from "mongoose";
import {
  Organization,
  OrganizationI,
  OrgMember,
} from "../../models/organization.model";
import { User, UserI } from "../../models/user.model";
import { InviteService } from "./invite.service";

/**
 * Custom error class with status code for HTTP responses
 */
class ApiError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.name = "ApiError";

    // Ensure proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

/**
 * Generates a URL-friendly slug from a string
 * @param name - The string to convert to a slug
 * @returns A URL-friendly slug
 */
async function generateSlug(name: string): Promise<string> {
  // Convert to lowercase and replace non-alphanumeric characters with hyphens
  let slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, ""); // Remove leading and trailing hyphens

  // Ensure slug is not empty
  if (!slug) {
    slug = "org";
  }

  return slug;
}

/**
 * Service for managing organizations
 */
export class OrganizationService {
  /**
   * Creates a personal organization for a user
   * @param user - The user document
   * @returns The ID of the created organization
   */
  public static async createPersonalOrg(user: UserI): Promise<Types.ObjectId> {
    const personalOrgName = `${user.profile?.company || user.email.split("@")[0]}'s Org`;
    const slug = await generateSlug(personalOrgName);

    // Create personal organization with user as owner
    const org = new Organization({
      name: personalOrgName,
      slug,
      profile: {
        contactEmail: user.email,
        // Copy any existing profile info from user if available
        ...(user.profile && {
          website: user.profile.website,
          description: user.profile.description,
          logo: user.profile.logo,
        }),
      },
      members: [
        {
          user: user._id,
          role: "admin",
          joinedAt: new Date(),
        },
      ],
    });

    await org.save();
    return org._id;
  }

  /**
   * Creates a new organization
   * @param name - Organization name
   * @param creatorUser - The user creating the organization
   * @returns The created organization document
   */
  public static async createOrg(
    name: string,
    creatorUser: UserI,
  ): Promise<OrganizationI> {
    const slug = await generateSlug(name);

    const org = new Organization({
      name,
      slug,
      profile: {
        contactEmail: creatorUser.email,
      },
      members: [
        {
          user: creatorUser._id,
          role: "admin",
          joinedAt: new Date(),
        },
      ],
    });

    await org.save();

    // Add org to user's organizations list
    await User.updateOne(
      { _id: creatorUser._id },
      { $addToSet: { organizations: org._id } },
    );

    return org;
  }

  /**
   * Retrieves an organization by ID with populated members
   * @param id - Organization ID
   * @returns The organization document with populated members
   */
  public static async getOrgById(
    id: string | Types.ObjectId,
  ): Promise<OrganizationI | null> {
    return Organization.findById(id)
      .populate("members.user", "email displayName profile.avatar")
      .populate("pendingInvites.invitedBy", "email displayName")
      .exec();
  }

  /**
   * Lists all organizations a user is a member of
   * @param userId - User ID
   * @returns Array of organizations
   */
  public static async listUserOrgs(
    userId: string | Types.ObjectId,
  ): Promise<OrganizationI[]> {
    return Organization.find({
      "members.user": userId,
    }).exec();
  }

  /**
   * Updates an organization's details
   * @param id - Organization ID
   * @param patch - Fields to update
   * @param actorUser - User performing the update
   * @returns The updated organization
   * @throws ApiError if user lacks permission
   */
  public static async updateOrg(
    id: string | Types.ObjectId,
    patch: Partial<Pick<OrganizationI, "name" | "profile">>,
    actorUser: UserI,
  ): Promise<OrganizationI> {
    // Verify user has admin rights
    const hasPermission = await this.isOrgAdmin(actorUser, id);
    if (!hasPermission) {
      throw new ApiError(
        403,
        "Insufficient permissions to update organization",
      );
    }

    // Prevent updating sensitive fields
    const sanitizedPatch: any = { ...patch };
    delete sanitizedPatch._id;
    delete sanitizedPatch.members;
    delete sanitizedPatch.slug;

    // If name is being updated, generate new slug
    if (sanitizedPatch.name) {
      sanitizedPatch.slug = await generateSlug(sanitizedPatch.name);
    }

    const org = await Organization.findByIdAndUpdate(
      id,
      { $set: sanitizedPatch },
      { new: true, runValidators: true },
    );

    if (!org) {
      throw new ApiError(404, "Organization not found");
    }

    return org;
  }

  /**
   * Invites a new member to an organization
   * @param orgId - Organization ID
   * @param email - Invitee's email
   * @param role - Role to assign
   * @param inviterUser - User sending the invite
   * @returns The invite token
   * @throws ApiError if user lacks permission
   */
  public static async inviteMember(
    orgId: string | Types.ObjectId,
    email: string,
    role: OrgMember["role"] = "member",
    inviterUser: UserI,
  ): Promise<string> {
    // Check if inviter has admin rights
    const hasPermission = await this.isOrgAdmin(inviterUser, orgId);
    if (!hasPermission) {
      throw new ApiError(403, "Insufficient permissions to invite members");
    }

    // Check if user is already a member
    const org = await this.getOrgById(orgId);
    if (!org) {
      throw new ApiError(404, "Organization not found");
    }

    // Initialize pendingInvites if it doesn't exist
    if (!org.pendingInvites) {
      org.pendingInvites = [];
    }

    // Case-insensitive email check for existing members
    const lowerCaseEmail = email.toLowerCase();
    const existingMember = org.members.find((member) => {
      // Handle cases where member.user might be populated or a reference
      const memberUser = member.user as any;
      return (
        memberUser &&
        ((memberUser.email &&
          memberUser.email.toLowerCase() === lowerCaseEmail) ||
          (typeof memberUser === "string" && memberUser.toString() === email))
      );
    });

    if (existingMember) {
      throw new ApiError(
        400,
        `User is already a member of this organization: ${org.id}`,
      );
    }

    // Check for existing pending invites
    const existingPendingInvite = org.pendingInvites.find(
      (invite) => invite.email.toLowerCase() === lowerCaseEmail,
    );

    if (existingPendingInvite) {
      // Remove the old pending invite to replace with new one
      org.pendingInvites = org.pendingInvites.filter(
        (invite) => invite.email.toLowerCase() !== lowerCaseEmail,
      );
    }

    // Use InviteService to generate a token and send invitation email
    const { token } = await InviteService.generate(
      orgId,
      email,
      role,
      inviterUser,
    );

    // Add to pending invites
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    org.pendingInvites.push({
      email: lowerCaseEmail,
      role,
      token,
      invitedBy: inviterUser._id,
      invitedAt: new Date(),
      expiresAt,
      emailSentCount: 1,
      lastEmailSentAt: new Date(),
    });

    await org.save();

    return token;
  }

  /**
   * Resends an invitation email
   * @param orgId - Organization ID
   * @param email - Email of the pending invite to resend
   * @param actorUser - User performing the resend
   * @throws ApiError if user lacks permission or invite not found
   */
  public static async resendInvite(
    orgId: string | Types.ObjectId,
    email: string,
    actorUser: UserI,
  ): Promise<void> {
    // Check if user has admin rights
    const hasPermission = await this.isOrgAdmin(actorUser, orgId);
    if (!hasPermission) {
      throw new ApiError(403, "Insufficient permissions to resend invitations");
    }

    const org = await this.getOrgById(orgId);
    if (!org) {
      throw new ApiError(404, "Organization not found");
    }

    // Initialize pendingInvites if it doesn't exist
    if (!org.pendingInvites) {
      org.pendingInvites = [];
    }

    // Find the pending invite
    const lowerCaseEmail = email.toLowerCase();
    const inviteIndex = org.pendingInvites.findIndex(
      (invite) => invite.email.toLowerCase() === lowerCaseEmail,
    );

    if (inviteIndex === -1) {
      throw new ApiError(404, "Pending invitation not found");
    }

    const invite = org.pendingInvites[inviteIndex];

    // Check if invite is expired
    if (new Date() > invite.expiresAt) {
      throw new ApiError(
        400,
        "Invitation has expired. Please create a new invitation.",
      );
    }

    // Get organization details for the email
    await InviteService.generate(orgId, invite.email, invite.role, actorUser);

    // Update the invite record
    org.pendingInvites[inviteIndex].emailSentCount += 1;
    org.pendingInvites[inviteIndex].lastEmailSentAt = new Date();

    await org.save();
  }

  /**
   * Rescinds (cancels) a pending invitation
   * @param orgId - Organization ID
   * @param email - Email of the pending invite to rescind
   * @param actorUser - User performing the rescind
   * @throws ApiError if user lacks permission or invite not found
   */
  public static async rescindInvite(
    orgId: string | Types.ObjectId,
    email: string,
    actorUser: UserI,
  ): Promise<void> {
    // Check if user has admin rights
    const hasPermission = await this.isOrgAdmin(actorUser, orgId);
    if (!hasPermission) {
      throw new ApiError(
        403,
        "Insufficient permissions to rescind invitations",
      );
    }

    const org = await this.getOrgById(orgId);
    if (!org) {
      throw new ApiError(404, "Organization not found");
    }

    // Initialize pendingInvites if it doesn't exist
    if (!org.pendingInvites) {
      org.pendingInvites = [];
    }

    // Find and remove the pending invite
    const lowerCaseEmail = email.toLowerCase();
    const originalLength = org.pendingInvites.length;
    org.pendingInvites = org.pendingInvites.filter(
      (invite) => invite.email.toLowerCase() !== lowerCaseEmail,
    );

    if (org.pendingInvites.length === originalLength) {
      throw new ApiError(404, "Pending invitation not found");
    }

    await org.save();
  }

  /**
   * Adds a user to an organization based on invite token
   * @param token - Invite token
   * @param user - User accepting the invite
   * @returns The updated organization
   */
  public static async acceptInvite(
    token: string,
    user: UserI,
  ): Promise<OrganizationI> {
    console.log("[organization.service] Starting acceptInvite process", {
      userEmail: user.email,
    });

    try {
      // Verify and decode token
      const tokenData = InviteService.verify(token);
      console.log("[organization.service] Invite token verified successfully", {
        tokenData,
      });

      // Validate email matches
      if (tokenData.email !== user.email) {
        console.error("[organization.service] Email mismatch in invite token", {
          tokenEmail: tokenData.email,
          userEmail: user.email,
        });
        throw new ApiError(
          403,
          "Invite token was issued for a different email address",
        );
      }

      // Get the organization
      const org = await Organization.findById(tokenData.orgId);
      if (!org) {
        console.error("[organization.service] Organization not found", {
          orgId: tokenData.orgId,
        });
        throw new ApiError(404, "Organization not found");
      }

      console.log("[organization.service] Found organization", {
        orgId: org._id.toString(),
        orgName: org.name,
        memberCount: org.members.length,
      });

      // Check if already a member - by ID or by email
      const isMemberById = org.members.some(
        (m) => m.user.toString() === user._id.toString(),
      );

      const isMemberByEmail = org.members.some((m) => {
        const memberUser = m.user as any; // Handle both populated and reference cases
        return (
          memberUser.email &&
          memberUser.email.toLowerCase() === user.email.toLowerCase()
        );
      });

      if (isMemberById || isMemberByEmail) {
        console.warn(
          "[organization.service] User is already a member of this organization",
          {
            userId: user._id.toString(),
            userEmail: user.email,
            orgId: org._id.toString(),
          },
        );

        // Return the org anyway, treating this as a successful operation
        // This prevents error messages when users click an invite link multiple times
        return org;
      }

      // Check if the pending invite still exists
      const lowerCaseEmail = user.email.toLowerCase();
      const pendingInviteIndex =
        org.pendingInvites?.findIndex(
          (invite) => invite.email.toLowerCase() === lowerCaseEmail,
        ) ?? -1;

      if (pendingInviteIndex === -1) {
        console.error(
          "[organization.service] Pending invite not found - may have already been accepted",
          {
            userEmail: user.email,
            orgId: org._id.toString(),
          },
        );
        throw new ApiError(
          400,
          "This invitation has already been accepted or is no longer valid",
        );
      }

      const pendingInvite = org.pendingInvites[pendingInviteIndex];

      // Check if invite is expired
      if (new Date() > pendingInvite.expiresAt) {
        console.error("[organization.service] Invite has expired", {
          userEmail: user.email,
          expiresAt: pendingInvite.expiresAt,
        });
        throw new ApiError(400, "This invitation has expired");
      }

      // Add member and remove pending invite atomically
      console.log(
        "[organization.service] Adding user to organization and removing pending invite",
        {
          userId: user._id.toString(),
          role: tokenData.role,
        },
      );

      org.members.push({
        user: user._id,
        role: tokenData.role as OrgMember["role"],
        joinedAt: new Date(),
      });

      // Remove the pending invite
      org.pendingInvites.splice(pendingInviteIndex, 1);

      // Save both changes atomically
      await org.save();
      console.log(
        "[organization.service] Organization saved with new member and pending invite removed",
      );

      // Add org to user's organizations
      console.log("[organization.service] Adding org to user.organizations", {
        userId: user._id.toString(),
        orgId: org._id.toString(),
        currentOrgs: user.organizations?.map((o) => o.toString()) || [],
      });

      // Ensure the organizations array exists
      if (!user.organizations) {
        user.organizations = [];
      }

      // Check if org is already in the user's organizations
      const orgAlreadyInUserOrgs = user.organizations.some(
        (orgId) => orgId.toString() === org._id.toString(),
      );

      if (!orgAlreadyInUserOrgs) {
        user.organizations.push(org._id);
        await user.save();
        console.log("[organization.service] User saved with new organization", {
          updatedOrgs: user.organizations.map((o) => o.toString()),
        });
      } else {
        console.warn(
          "[organization.service] Organization was already in user.organizations array, skipping update",
        );
      }

      return org;
    } catch (error: any) {
      console.error("[organization.service] Error in acceptInvite", error);
      if (error instanceof ApiError) {
        throw error;
      }
      throw new ApiError(400, error.message || "Invalid invitation token");
    }
  }

  /**
   * Removes a member from an organization
   * @param orgId - Organization ID
   * @param memberId - ID of the user to remove
   * @param actorUser - User performing the removal
   * @returns The updated organization
   * @throws ApiError if user lacks permission or is removing the last owner
   */
  public static async removeMember(
    orgId: string | Types.ObjectId,
    memberId: string | Types.ObjectId,
    actorUser: UserI,
  ): Promise<OrganizationI> {
    // Verify user has admin rights
    const hasPermission = await this.isOrgAdmin(actorUser, orgId);
    if (!hasPermission) {
      console.error(
        "[organization.service] User does not have admin rights to remove members",
        {
          actorUserEmail: actorUser.email,
          orgId,
          memberId,
        },
      );
      throw new ApiError(403, "Insufficient permissions to remove members");
    }

    const org = await this.getOrgById(orgId);
    if (!org) {
      console.error("[organization.service] Organization not found", {
        orgId,
      });
      throw new ApiError(404, "Organization not found");
    }

    // Find the member to remove
    const targetMemberIdx = org.members.findIndex(
      (m) => m.user._id.toString() === memberId.toString(),
    );
    if (targetMemberIdx === -1) {
      console.error("[organization.service] Member not found in organization", {
        orgId,
        memberId,
      });
      throw new ApiError(404, "Member not found in organization");
    }

    const targetMember = org.members[targetMemberIdx];

    // Check if removing last admin
    if (targetMember.role === "admin") {
      const adminCount = org.members.filter((m) => m.role === "admin").length;
      if (adminCount <= 1) {
        console.error(
          "[organization.service] Cannot remove the last admin of an organization",
          {
            orgId,
            memberId,
          },
        );
        throw new ApiError(
          400,
          "Cannot remove the last admin of an organization",
        );
      }
    }

    try {
      // Remove member
      org.members.splice(targetMemberIdx, 1);
      await org.save();
    } catch (error: any) {
      console.error("[organization.service] Error removing member", {
        memberId,
        orgId,
        error,
      });
      throw error;
    }

    try {
      // Remove org from user's organizations list
      await User.updateOne(
        { _id: memberId },
        { $pull: { organizations: org._id } },
      );
    } catch (error: any) {
      console.error("[organization.service] Error removing org from user", {
        memberId,
        orgId,
        error,
      });
      throw error;
    }

    try {
      // If this was the user's default org, update it
      const user = await User.findById(memberId);
      if (user && user.defaultOrg?.toString() === org._id.toString()) {
        // Set a different org as default if available
        if (user.organizations && user.organizations.length > 0) {
          user.defaultOrg = user.organizations[0];
          console.log("[organization.service] Updated user default org", {
            memberId,
            orgId,
            defaultOrg: user.defaultOrg,
          });
        } else {
          user.defaultOrg = undefined;
          console.warn(
            "[organization.service] Removed user default org as part of removing member",
            {
              memberId,
              orgId,
            },
          );
          await user.save();
        }
      }
    } catch (error: any) {
      console.error("[organization.service] Error updating user default org", {
        memberId,
        orgId,
        error,
      });
    }
    return org;
  }

  /**
   * Changes a member's role in an organization
   * @param orgId - Organization ID
   * @param memberId - ID of the user to update
   * @param newRole - New role to assign
   * @param actorUser - User performing the role change
   * @returns The updated organization
   * @throws ApiError if user lacks permission or is trying to demote the last owner
   */
  public static async changeRole(
    orgId: string | Types.ObjectId,
    memberId: string | Types.ObjectId,
    newRole: OrgMember["role"],
    actorUser: UserI,
  ): Promise<OrganizationI> {
    // Verify user has admin rights
    const hasPermission = await this.isOrgAdmin(actorUser, orgId);
    if (!hasPermission) {
      throw new ApiError(
        403,
        "Insufficient permissions to change member roles",
      );
    }

    const org = await this.getOrgById(orgId);
    if (!org) {
      throw new ApiError(404, "Organization not found");
    }

    // Find target member
    const targetMemberIdx = org.members.findIndex(
      (m) => m.user._id.toString() === memberId.toString(),
    );

    if (targetMemberIdx === -1) {
      throw new ApiError(404, "Member not found in organization");
    }

    const currentRole = org.members[targetMemberIdx].role;

    // Check if demoting the last admin
    if (currentRole === "admin" && newRole !== "admin") {
      const adminCount = org.members.filter((m) => m.role === "admin").length;
      if (adminCount <= 1) {
        throw new ApiError(
          400,
          "Cannot demote the last admin of an organization",
        );
      }
    }

    // Update role
    org.members[targetMemberIdx].role = newRole;
    await org.save();

    return org;
  }

  /**
   * Checks if a user is a member of an organization
   * @param user - User to check
   * @param orgId - Organization ID
   * @returns Whether the user is a member
   */
  public static async isOrgMember(
    user: UserI,
    orgId: string | Types.ObjectId,
  ): Promise<boolean> {
    const org = await Organization.findOne({
      _id: orgId,
      "members.user": user._id,
    });

    return !!org;
  }

  /**
   * Checks if a user is an admin of an organization
   * @param user - User to check
   * @param orgId - Organization ID
   * @returns Whether the user is an admin
   */
  public static async isOrgAdmin(
    user: UserI,
    orgId: string | Types.ObjectId,
  ): Promise<boolean> {
    const org = await Organization.findOne({
      _id: orgId,
      "members.user": user._id,
      members: {
        $elemMatch: {
          user: user._id,
          role: "admin",
        },
      },
    });

    return !!org;
  }

  public static async deleteOrg(
    orgId: string | Types.ObjectId,
    actorUser: UserI,
  ): Promise<void> {
    // Verify the actor is an admin of the organization
    const isAdmin = await this.isOrgAdmin(actorUser, orgId);
    if (!isAdmin) {
      throw new ApiError(
        403,
        "Insufficient permissions to delete organization",
      );
    }

    // Check if the organization has any Apps/apps
    const App = require("../../models/app.model").default;
    const appCount = await App.countDocuments({ organizationId: orgId });
    if (appCount > 0) {
      throw new ApiError(
        400,
        "Organization cannot be deleted while it owns one or more applications",
      );
    }

    // Fetch the organization with populated members for further checks
    const org = await this.getOrgById(orgId);
    if (!org) {
      throw new ApiError(404, "Organization not found");
    }

    // Ensure every member is an admin in at least one other organization
    for (const member of org.members) {
      const userId = (member.user as any)._id ?? member.user; // supports populated & ref
      // Find other orgs where this user is an admin (excluding the current one)
      const otherAdminOrg = await Organization.findOne({
        _id: { $ne: orgId },
        members: { $elemMatch: { user: userId, role: "admin" } },
      }).lean();

      if (!otherAdminOrg) {
        const memberUser = member.user as any;
        const email =
          typeof memberUser === "string" ? memberUser : memberUser.email;
        throw new ApiError(
          400,
          `Member ${email || userId.toString()} must be an admin of at least one other organization before deletion`,
        );
      }
    }

    // All checks passed – proceed with deletion

    // Remove the organization document
    await Organization.findByIdAndDelete(orgId);

    // Update each member – pull org from their organizations list and fix defaultOrg
    for (const member of org.members) {
      const userId = (member.user as any)._id ?? member.user;
      const user = await User.findById(userId);
      if (!user) continue;

      // Remove org from organizations array
      if (user.organizations) {
        user.organizations = user.organizations.filter(
          (id) => id.toString() !== org._id.toString(),
        );
      }

      // Fix defaultOrg if it was the deleted one
      if (user.defaultOrg?.toString() === org._id.toString()) {
        // Choose first org that the user is an admin of
        let adminOrgFound = false;

        if (user.organizations && user.organizations.length > 0) {
          // Look through each org the user is a member of
          for (const userOrgId of user.organizations) {
            // Skip if this is the org being deleted
            if (userOrgId.toString() === org._id.toString()) continue;

            // Check if user is admin in this org
            const userOrg = await Organization.findOne({
              _id: userOrgId,
              members: {
                $elemMatch: {
                  user: user._id,
                  role: "admin",
                },
              },
            });

            if (userOrg) {
              // Found an org where user is admin, set as default
              user.defaultOrg = userOrgId;
              adminOrgFound = true;
              break;
            }
          }
        }

        // If no admin org found, fall back to first org or undefined
        if (!adminOrgFound) {
          user.defaultOrg =
            user.organizations && user.organizations.length > 0
              ? user.organizations[0]
              : undefined;
        }
      }

      await user.save();
    }
  }
}
