/**
 * @fileoverview Hono organization routes.
 * Legacy organization management endpoints.
 * Mounted at: /api/orgs
 */

import { Hono } from "hono";
import jwt from "jsonwebtoken";
import { Types } from "mongoose";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import { OrganizationService } from "../../../services/core/organization.service";
import { User } from "../../../models/user.model";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "organization.routes" });

const app = new Hono<AppEnv>();

const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";

// ============================================================================
// Routes
// ============================================================================

// List user's organizations
app.get("/", authMiddleware, listUserOrgs);

// Create organization
app.post("/", authMiddleware, createOrg);

// Get specific organization
app.get("/:orgId", authMiddleware, getOrg);

// Update organization
app.put("/:orgId", authMiddleware, updateOrg);

// Delete organization
app.delete("/:orgId", authMiddleware, deleteOrg);

// Member management
app.post("/:orgId/members", authMiddleware, invite);
app.post("/accept/:token", authMiddleware, acceptInvite);
app.patch("/:orgId/members/:memberId", authMiddleware, changeRole);
app.delete("/:orgId/members/:memberId", authMiddleware, removeMember);
app.post("/:orgId/invites/resend", authMiddleware, resendInvite);
app.post("/:orgId/invites/rescind", authMiddleware, rescindInvite);

// ============================================================================
// Middleware
// ============================================================================

/**
 * Authentication middleware - validates JWT token and adds user email to context.
 */
async function authMiddleware(c: AppContext, next: () => Promise<void>) {
  const authHeader = c.req.header("authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ success: false, message: "Authentication required" }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const userData = jwt.verify(token, AUGMENTOS_AUTH_JWT_SECRET) as jwt.JwtPayload;

    if (!userData || !userData.email) {
      return c.json({ success: false, message: "Invalid token" }, 401);
    }

    c.set("email", userData.email.toLowerCase());

    // Check for organization context in headers
    const orgIdHeader = c.req.header("x-org-id");
    if (orgIdHeader && typeof orgIdHeader === "string") {
      try {
        (c as any).currentOrgId = new Types.ObjectId(orgIdHeader);
      } catch (e) {
        logger.debug({ orgIdHeader }, "Invalid org ID in header");
      }
    }

    await next();
  } catch (error) {
    logger.error(error, "Token verification error");
    return c.json({ success: false, message: "Authentication failed" }, 401);
  }
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /api/orgs
 * List all organizations the user is a member of.
 */
async function listUserOrgs(c: AppContext) {
  try {
    const userEmail = c.get("email");
    const user = await User.findOne({ email: userEmail });

    if (!user) {
      return c.json({ success: false, message: "User not found" }, 404);
    }

    const orgs = await OrganizationService.listUserOrgs(user._id);

    return c.json({ success: true, data: orgs });
  } catch (error) {
    logger.error(error, "Error listing user organizations");
    return c.json({ success: false, message: "Failed to list organizations" }, 500);
  }
}

/**
 * POST /api/orgs
 * Create a new organization.
 */
async function createOrg(c: AppContext) {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { name } = body as { name?: string };

    if (!name) {
      return c.json({ success: false, message: "Organization name is required" }, 400);
    }

    const userEmail = c.get("email");
    const user = await User.findOne({ email: userEmail });

    if (!user) {
      return c.json({ success: false, message: "User not found" }, 404);
    }

    const newOrg = await OrganizationService.createOrg(name, user);

    return c.json({ success: true, data: newOrg }, 201);
  } catch (error) {
    logger.error(error, "Error creating organization");
    return c.json({ success: false, message: "Failed to create organization" }, 500);
  }
}

/**
 * GET /api/orgs/:orgId
 * Get a specific organization by ID.
 */
async function getOrg(c: AppContext) {
  try {
    const orgId = c.req.param("orgId");
    const userEmail = c.get("email");
    const user = await User.findOne({ email: userEmail });

    if (!user) {
      return c.json({ success: false, message: "User not found" }, 404);
    }

    // Verify membership
    const isMember = await OrganizationService.isOrgMember(user, orgId);

    if (!isMember) {
      return c.json({ success: false, message: "Not a member of this organization" }, 403);
    }

    const org = await OrganizationService.getOrgById(orgId);

    if (!org) {
      return c.json({ success: false, message: "Organization not found" }, 404);
    }

    return c.json({ success: true, data: org });
  } catch (error) {
    logger.error(error, "Error getting organization");
    return c.json({ success: false, message: "Failed to get organization" }, 500);
  }
}

/**
 * PUT /api/orgs/:orgId
 * Update an organization.
 */
async function updateOrg(c: AppContext) {
  try {
    const orgId = c.req.param("orgId");
    const body = await c.req.json().catch(() => ({}));
    const userEmail = c.get("email");
    const user = await User.findOne({ email: userEmail });

    if (!user) {
      return c.json({ success: false, message: "User not found" }, 404);
    }

    // Check if user has admin access
    const isAdmin = await OrganizationService.isOrgAdmin(user, orgId);
    if (!isAdmin) {
      return c.json({ success: false, message: "Admin access required" }, 403);
    }

    // Sanitize updates - only allow certain fields
    const validFields = ["name", "profile"];
    const sanitizedUpdates: Record<string, any> = {};

    for (const field of validFields) {
      if (body[field] !== undefined) {
        sanitizedUpdates[field] = body[field];
      }
    }

    const updatedOrg = await OrganizationService.updateOrg(orgId, sanitizedUpdates, user);

    return c.json({ success: true, data: updatedOrg });
  } catch (error) {
    logger.error(error, "Error updating organization");
    return c.json({ success: false, message: (error as Error).message || "Failed to update organization" }, 500);
  }
}

/**
 * DELETE /api/orgs/:orgId
 * Delete an organization.
 */
async function deleteOrg(c: AppContext) {
  try {
    const orgId = c.req.param("orgId");
    const userEmail = c.get("email");
    const user = await User.findOne({ email: userEmail });

    if (!user) {
      return c.json({ success: false, message: "User not found" }, 404);
    }

    // Check if user has admin access
    const isAdmin = await OrganizationService.isOrgAdmin(user, orgId);
    if (!isAdmin) {
      return c.json({ success: false, message: "Admin access required" }, 403);
    }

    await OrganizationService.deleteOrg(orgId, user);

    return c.json({ success: true, message: "Organization deleted successfully" });
  } catch (error) {
    logger.error(error, "Error deleting organization");
    return c.json({ success: false, message: (error as Error).message || "Failed to delete organization" }, 500);
  }
}

/**
 * POST /api/orgs/:orgId/invite
 * Invite a user to the organization.
 */
async function invite(c: AppContext) {
  try {
    const orgId = c.req.param("orgId");
    const body = await c.req.json().catch(() => ({}));
    const { email } = body as { email?: string };

    if (!email) {
      return c.json({ success: false, message: "Email is required" }, 400);
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return c.json({ success: false, message: "Invalid email format" }, 400);
    }

    const userEmail = c.get("email");
    const user = await User.findOne({ email: userEmail });

    if (!user) {
      return c.json({ success: false, message: "User not found" }, 404);
    }

    const inviteToken = await OrganizationService.inviteMember(orgId, email, "member", user);

    return c.json({
      success: true,
      data: {
        inviteToken,
        inviteeEmail: email,
      },
      message: "Invitation sent successfully",
    });
  } catch (error) {
    logger.error(error, "Error inviting user to organization");
    return c.json({ success: false, message: (error as Error).message || "Failed to send invitation" }, 500);
  }
}

/**
 * POST /api/orgs/:orgId/accept-invite
 * Accept an organization invitation.
 */
async function acceptInvite(c: AppContext) {
  try {
    const token = c.req.param("token");
    const userEmail = c.get("email");
    const user = await User.findOne({ email: userEmail });

    if (!user) {
      return c.json({ success: false, message: "User not found" }, 404);
    }

    const org = await OrganizationService.acceptInvite(token, user);

    return c.json({ success: true, data: org, message: "Successfully joined organization" });
  } catch (error) {
    logger.error(error, "Error accepting invitation");
    return c.json({ success: false, message: (error as Error).message || "Failed to accept invitation" }, 500);
  }
}

/**
 * PATCH /api/orgs/:orgId/members/:memberId
 * Change a member's role.
 */
async function changeRole(c: AppContext) {
  try {
    const orgId = c.req.param("orgId");
    const memberId = c.req.param("memberId");
    const body = await c.req.json().catch(() => ({}));
    const { role } = body as { role?: "admin" | "member" };

    if (!role || !["admin", "member"].includes(role)) {
      return c.json({ success: false, message: "Valid role (admin or member) is required" }, 400);
    }

    const userEmail = c.get("email");
    const user = await User.findOne({ email: userEmail });

    if (!user) {
      return c.json({ success: false, message: "User not found" }, 404);
    }

    const updatedOrg = await OrganizationService.changeRole(orgId, memberId, role, user);

    return c.json({ success: true, data: updatedOrg, message: "Role updated successfully" });
  } catch (error) {
    logger.error(error, "Error changing member role");
    return c.json({ success: false, message: (error as Error).message || "Failed to change role" }, 500);
  }
}

/**
 * DELETE /api/orgs/:orgId/members/:memberId
 * Remove a member from the organization.
 */
async function removeMember(c: AppContext) {
  try {
    const orgId = c.req.param("orgId");
    const memberId = c.req.param("memberId");
    const userEmail = c.get("email");
    const user = await User.findOne({ email: userEmail });

    if (!user) {
      return c.json({ success: false, message: "User not found" }, 404);
    }

    // Prevent self-removal if you're the only admin
    if (memberId === user._id.toString()) {
      return c.json({ success: false, message: "Cannot remove yourself from the organization" }, 400);
    }

    await OrganizationService.removeMember(orgId, memberId, user);

    return c.json({ success: true, message: "Member removed successfully" });
  } catch (error) {
    logger.error(error, "Error removing member");
    return c.json({ success: false, message: (error as Error).message || "Failed to remove member" }, 500);
  }
}

/**
 * POST /api/orgs/:orgId/resend-invite
 * Resend an invitation email.
 */
async function resendInvite(c: AppContext) {
  try {
    const orgId = c.req.param("orgId");
    const body = await c.req.json().catch(() => ({}));
    const { email } = body as { email?: string };

    if (!email) {
      return c.json({ success: false, message: "Email is required" }, 400);
    }

    const userEmail = c.get("email");
    const user = await User.findOne({ email: userEmail });

    if (!user) {
      return c.json({ success: false, message: "User not found" }, 404);
    }

    await OrganizationService.resendInvite(orgId, email, user);

    return c.json({ success: true, message: "Invitation resent successfully" });
  } catch (error) {
    logger.error(error, "Error resending invitation");
    return c.json({ success: false, message: (error as Error).message || "Failed to resend invitation" }, 500);
  }
}

/**
 * POST /api/orgs/:orgId/rescind-invite
 * Rescind/cancel an invitation.
 */
async function rescindInvite(c: AppContext) {
  try {
    const orgId = c.req.param("orgId");
    const body = await c.req.json().catch(() => ({}));
    const { email } = body as { email?: string };

    if (!email) {
      return c.json({ success: false, message: "Email is required" }, 400);
    }

    const userEmail = c.get("email");
    const user = await User.findOne({ email: userEmail });

    if (!user) {
      return c.json({ success: false, message: "User not found" }, 404);
    }

    await OrganizationService.rescindInvite(orgId, email, user);

    return c.json({ success: true, message: "Invitation rescinded successfully" });
  } catch (error) {
    logger.error(error, "Error rescinding invitation");
    return c.json({ success: false, message: (error as Error).message || "Failed to rescind invitation" }, 500);
  }
}

export default app;
