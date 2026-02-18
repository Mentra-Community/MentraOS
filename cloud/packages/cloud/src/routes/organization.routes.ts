// routes/organization.routes.ts
import { Router, Request, Response, NextFunction } from "express";
import { OrganizationService } from "../services/core/organization.service";
import jwt from "jsonwebtoken";
import { User } from "../models/user.model";
import { Types } from "mongoose";
import { logger as rootLogger } from "../services/logging/pino-logger";

const logger = rootLogger.child({ module: "organization.routes" });
const router = Router();

// Constants
const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";

// Types
interface OrgRequest extends Request {
  userEmail: string;
  currentOrgId?: Types.ObjectId;
}

/**
 * Authentication middleware - validates JWT token and adds user email to request
 */
const authMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      message: "Authentication required",
    });
  }

  const token = authHeader.substring(7); // Remove 'Bearer ' prefix

  try {
    const userData = jwt.verify(token, AUGMENTOS_AUTH_JWT_SECRET);
    if (!userData || !(userData as jwt.JwtPayload).email) {
      return res.status(401).json({
        success: false,
        message: "Invalid token",
      });
    }

    (req as OrgRequest).userEmail = (
      (userData as jwt.JwtPayload).email as string
    ).toLowerCase();

    // Check for organization context in headers
    const orgIdHeader = req.headers["x-org-id"];
    if (orgIdHeader && typeof orgIdHeader === "string") {
      (req as OrgRequest).currentOrgId = new Types.ObjectId(orgIdHeader);
    }

    next();
  } catch (error) {
    logger.error(error, "Token verification error:");
    return res.status(401).json({
      success: false,
      message: "Authentication failed",
    });
  }
};

/**
 * Authorization middleware - checks if user has admin role in organization
 */
const authz = (requiredRole: "admin" | "member" = "admin") => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const orgId = req.params.orgId;
    if (!orgId) {
      return res.status(400).json({
        success: false,
        message: "Organization ID is required",
      });
    }

    try {
      const userEmail = (req as OrgRequest).userEmail;
      if (!userEmail) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

      // Get user from email
      const user = await User.findOne({ email: userEmail });
      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found",
        });
      }

      // Check permission level
      let hasPermission = false;

      if (requiredRole === "member") {
        hasPermission = await OrganizationService.isOrgMember(user, orgId);
      } else {
        hasPermission = await OrganizationService.isOrgAdmin(user, orgId);
      }

      if (!hasPermission) {
        return res.status(403).json({
          success: false,
          message: "Insufficient permissions for this organization",
        });
      }

      // Permission granted, continue
      next();
    } catch (error) {
      logger.error(error as Error, "Authorization error:");
      return res.status(500).json({
        success: false,
        message: "Authorization check failed",
      });
    }
  };
};

// Controller functions
/**
 * List all organizations the user is a member of
 */
const listUserOrgs = async (req: Request, res: Response) => {
  try {
    const userEmail = (req as OrgRequest).userEmail;
    const user = await User.findOne({ email: userEmail });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const orgs = await OrganizationService.listUserOrgs(user._id);

    res.json({
      success: true,
      data: orgs,
    });
  } catch (error) {
    logger.error(error as Error, "Error listing user organizations:");
    res.status(500).json({
      success: false,
      message: "Failed to list organizations",
    });
  }
};

/**
 * Create a new organization
 */
const createOrg = async (req: Request, res: Response) => {
  try {
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        message: "Organization name is required",
      });
    }

    const userEmail = (req as OrgRequest).userEmail;
    const user = await User.findOne({ email: userEmail });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const newOrg = await OrganizationService.createOrg(name, user);

    res.status(201).json({
      success: true,
      data: newOrg,
    });
  } catch (error) {
    logger.error(error as Error, "Error creating organization:");
    res.status(500).json({
      success: false,
      message: "Failed to create organization",
    });
  }
};

/**
 * Get a specific organization by ID
 */
const getOrg = async (req: Request, res: Response) => {
  try {
    const { orgId } = req.params;
    const userEmail = (req as OrgRequest).userEmail;
    const user = await User.findOne({ email: userEmail });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Check if user is a member
    const isMember = await OrganizationService.isOrgMember(user, orgId);
    if (!isMember) {
      return res.status(403).json({
        success: false,
        message: "You are not a member of this organization",
      });
    }

    const org = await OrganizationService.getOrgById(orgId);

    if (!org) {
      return res.status(404).json({
        success: false,
        message: "Organization not found",
      });
    }

    res.json({
      success: true,
      data: org,
    });
  } catch (error) {
    logger.error(error as Error, "Error fetching organization:");
    res.status(500).json({
      success: false,
      message: "Failed to fetch organization",
    });
  }
};

/**
 * Update an organization's details
 */
const updateOrg = async (req: Request, res: Response) => {
  try {
    const { orgId } = req.params;
    const updates = req.body;
    const userEmail = (req as OrgRequest).userEmail;
    const user = await User.findOne({ email: userEmail });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Validate update payload
    const validFields = ["name", "profile"];
    const sanitizedUpdates: any = {};

    for (const field of Object.keys(updates)) {
      if (validFields.includes(field)) {
        sanitizedUpdates[field] = updates[field];
      }
    }

    const updatedOrg = await OrganizationService.updateOrg(
      orgId,
      sanitizedUpdates,
      user,
    );

    res.json({
      success: true,
      data: updatedOrg,
    });
  } catch (error: any) {
    logger.error("Error updating organization:", error);

    // Check for specific error types
    if (error.statusCode === 404) {
      return res.status(404).json({
        success: false,
        message: error.message,
      });
    }

    if (error.statusCode === 403) {
      return res.status(403).json({
        success: false,
        message: error.message,
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to update organization",
    });
  }
};

/**
 * Invite a new member to the organization
 */
const invite = async (req: Request, res: Response) => {
  try {
    const { orgId } = req.params;
    const { email, role = "member" } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email address is required",
      });
    }

    // Validate role
    if (!["admin", "member"].includes(role)) {
      return res.status(400).json({
        success: false,
        message: "Invalid role. Must be admin or member",
      });
    }

    const userEmail = (req as OrgRequest).userEmail;
    const user = await User.findOne({ email: userEmail });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const inviteToken = await OrganizationService.inviteMember(
      orgId,
      email,
      role,
      user,
    );

    // In a real implementation, this would trigger an email through a notification service

    res.json({
      success: true,
      data: {
        inviteToken,
        inviteeEmail: email,
        role,
      },
      message: `Invitation sent to ${email}`,
    });
  } catch (error: any) {
    logger.error("Error inviting member:", error);

    // Check for specific error types
    if (error.statusCode === 404) {
      return res.status(404).json({
        success: false,
        message: error.message,
      });
    }

    if (error.statusCode === 403) {
      return res.status(403).json({
        success: false,
        message: error.message,
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to send invitation",
    });
  }
};

/**
 * Change a member's role in the organization
 */
const changeRole = async (req: Request, res: Response) => {
  try {
    const { orgId, memberId } = req.params;
    const { role } = req.body;

    if (!role) {
      return res.status(400).json({
        success: false,
        message: "Role is required",
      });
    }

    // Validate role
    if (!["admin", "member"].includes(role)) {
      return res.status(400).json({
        success: false,
        message: "Invalid role. Must be admin or member",
      });
    }

    const userEmail = (req as OrgRequest).userEmail;
    const user = await User.findOne({ email: userEmail });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const updatedOrg = await OrganizationService.changeRole(
      orgId,
      memberId,
      role,
      user,
    );

    res.json({
      success: true,
      data: updatedOrg,
      message: `Member role updated to ${role}`,
    });
  } catch (error: any) {
    logger.error("Error changing member role:", error);

    // Check for specific error types
    if (error.statusCode === 404) {
      return res.status(404).json({
        success: false,
        message: error.message,
      });
    }

    if (error.statusCode === 403) {
      return res.status(403).json({
        success: false,
        message: error.message,
      });
    }

    if (error.statusCode === 400) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to change member role",
    });
  }
};

/**
 * Remove a member from the organization
 */
const remove = async (req: Request, res: Response) => {
  try {
    const { orgId, memberId } = req.params;
    const userEmail = (req as OrgRequest).userEmail;
    const user = await User.findOne({ email: userEmail });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    await OrganizationService.removeMember(orgId, memberId, user);

    res.json({
      success: true,
      message: "Member removed successfully",
    });
  } catch (error: any) {
    logger.error("Error removing member:", error);

    // Check for specific error types
    if (error.statusCode === 404) {
      return res.status(404).json({
        success: false,
        message: error.message,
      });
    }

    if (error.statusCode === 403) {
      return res.status(403).json({
        success: false,
        message: error.message,
      });
    }

    if (error.statusCode === 400) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to remove member",
    });
  }
};

/**
 * Accept an invitation to join an organization
 */
const acceptInvite = async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const userEmail = (req as OrgRequest).userEmail;
    const user = await User.findOne({ email: userEmail });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const org = await OrganizationService.acceptInvite(token, user);

    res.json({
      success: true,
      data: org,
      message: "You have successfully joined the organization",
    });
  } catch (error: any) {
    logger.error("Error accepting invitation:", error);

    // Check for specific error types
    if (error.statusCode === 404) {
      return res.status(404).json({
        success: false,
        message: error.message,
      });
    }

    if (error.statusCode === 403) {
      return res.status(403).json({
        success: false,
        message: error.message,
      });
    }

    if (error.statusCode === 400) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to accept invitation",
    });
  }
};

/**
 * Delete an organization
 */
const deleteOrg = async (req: Request, res: Response) => {
  try {
    const { orgId } = req.params;
    const userEmail = (req as OrgRequest).userEmail;
    const user = await User.findOne({ email: userEmail });

    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    await OrganizationService.deleteOrg(orgId, user);

    res.json({ success: true, message: "Organization deleted successfully" });
  } catch (error: any) {
    logger.error("Error deleting organization:", error);

    if (error.statusCode === 404) {
      return res.status(404).json({ success: false, message: error.message });
    }
    if (error.statusCode === 403) {
      return res.status(403).json({ success: false, message: error.message });
    }
    if (error.statusCode === 400) {
      return res.status(400).json({ success: false, message: error.message });
    }

    res
      .status(500)
      .json({ success: false, message: "Failed to delete organization" });
  }
};

/**
 * Resend an invitation email
 */
const resendInvite = async (req: Request, res: Response) => {
  try {
    const { orgId } = req.params;
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email address is required",
      });
    }

    const userEmail = (req as OrgRequest).userEmail;
    const user = await User.findOne({ email: userEmail });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    await OrganizationService.resendInvite(orgId, email, user);

    res.json({
      success: true,
      message: `Invitation resent to ${email}`,
    });
  } catch (error: any) {
    logger.error("Error resending invite:", error);

    if (error.statusCode === 404) {
      return res.status(404).json({
        success: false,
        message: error.message,
      });
    }

    if (error.statusCode === 403) {
      return res.status(403).json({
        success: false,
        message: error.message,
      });
    }

    if (error.statusCode === 400) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to resend invitation",
    });
  }
};

/**
 * Rescind (cancel) a pending invitation
 */
const rescindInvite = async (req: Request, res: Response) => {
  try {
    const { orgId } = req.params;
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email address is required",
      });
    }

    const userEmail = (req as OrgRequest).userEmail;
    const user = await User.findOne({ email: userEmail });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    await OrganizationService.rescindInvite(orgId, email, user);

    res.json({
      success: true,
      message: "Invitation rescinded successfully",
    });
  } catch (error: any) {
    logger.error("Error rescinding invite:", error);

    if (error.statusCode === 404) {
      return res.status(404).json({
        success: false,
        message: error.message,
      });
    }

    if (error.statusCode === 403) {
      return res.status(403).json({
        success: false,
        message: error.message,
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to rescind invitation",
    });
  }
};

// Route definitions
router.get("/", authMiddleware, listUserOrgs);
router.post("/", authMiddleware, createOrg);
router.get("/:orgId", authMiddleware, getOrg);
router.put("/:orgId", authMiddleware, authz("admin"), updateOrg);
router.delete("/:orgId", authMiddleware, authz("admin"), deleteOrg);
router.post("/:orgId/members", authMiddleware, authz("admin"), invite);
router.patch(
  "/:orgId/members/:memberId",
  authMiddleware,
  authz("admin"),
  changeRole,
);
router.delete(
  "/:orgId/members/:memberId",
  authMiddleware,
  authz("admin"),
  remove,
);
router.post("/accept/:token", authMiddleware, acceptInvite);
router.post(
  "/:orgId/invites/resend",
  authMiddleware,
  authz("admin"),
  resendInvite,
);
router.post(
  "/:orgId/invites/rescind",
  authMiddleware,
  authz("admin"),
  rescindInvite,
);

export default router;
