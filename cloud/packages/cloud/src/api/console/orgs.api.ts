/**
 * Console Organization API (Skeleton)
 *
 * Base: /api/console/orgs
 * Mount: app.use("/api/console/orgs", authenticateConsole, orgsApi)
 *
 * Endpoints:
 * - GET    /                 -> list organizations for the authenticated console user
 * - POST   /                 -> create a new organization
 * - GET    /:orgId           -> get organization details
 * - PUT    /:orgId           -> update organization details (admin)
 * - DELETE /:orgId           -> delete organization (admin)
 * - POST   /:orgId/members   -> invite member (admin)
 * - PATCH  /:orgId/members/:memberId  -> change member role (admin)
 * - DELETE /:orgId/members/:memberId  -> remove member (admin)
 * - POST   /accept/:token    -> accept invitation token
 * - POST   /:orgId/invites/resend   -> resend invite email (admin)
 * - POST   /:orgId/invites/rescind  -> rescind invite email (admin)
 */

import { Router, Request, Response } from "express";

const router = Router();

/**
 * Routes — declared first, handlers below (function declarations are hoisted)
 * NOTE: No per-route middleware - authenticateConsole applied at mount point
 */

// Routes (declare first; handlers defined below)
router.get("/", listOrgs);
router.post("/", createOrg);
router.get("/:orgId", getOrgById);
router.put("/:orgId", updateOrgById);
router.delete("/:orgId", deleteOrgById);
router.post("/accept/:token", acceptInvite);
router.post("/:orgId/members", inviteMember);
router.delete("/:orgId/members/:memberId", removeMember);
router.patch("/:orgId/members/:memberId", changeMemberRole);
router.post("/:orgId/invites/resend", resendInviteEmail);
router.post("/:orgId/invites/rescind", rescindInviteEmail);

// Handlers (function declarations - hoisted)
async function listOrgs(req: Request, res: Response) {
  try {
    const email = req.console?.email;
    if (!email) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Missing console email",
      });
    }

    const mod = await import("../../services/console/orgs.service");
    const orgs = await mod.listUserOrgs(email);

    return res.json({ success: true, data: orgs });
  } catch (e: any) {
    const status =
      e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    return res.status(status).json({
      error: e?.message || "Failed to list organizations",
    });
  }
}

async function createOrg(req: Request, res: Response) {
  try {
    const email = req.console?.email;
    if (!email) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Missing console email",
      });
    }

    const { name } = req.body || {};
    const mod = await import("../../services/console/orgs.service");
    const org = await mod.createOrg(email, name);

    return res.status(201).json({ success: true, data: org });
  } catch (e: any) {
    const status =
      e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    return res.status(status).json({
      error: e?.message || "Failed to create organization",
    });
  }
}

async function getOrgById(req: Request, res: Response) {
  try {
    const email = req.console?.email;
    if (!email) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Missing console email",
      });
    }

    const { orgId } = req.params;
    if (!orgId) {
      return res.status(400).json({ error: "Organization ID is required" });
    }

    const mod = await import("../../services/console/orgs.service");
    const org = await mod.getOrg(email, orgId);

    return res.json({ success: true, data: org });
  } catch (e: any) {
    const status =
      e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    return res.status(status).json({
      error: e?.message || "Failed to fetch organization",
    });
  }
}

async function updateOrgById(req: Request, res: Response) {
  try {
    const email = req.console?.email;
    if (!email) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Missing console email",
      });
    }

    const { orgId } = req.params;
    if (!orgId) {
      return res.status(400).json({ error: "Organization ID is required" });
    }

    const patch = req.body ?? {};
    const mod = await import("../../services/console/orgs.service");
    const org = await mod.updateOrg(email, orgId, patch);

    return res.json({ success: true, data: org });
  } catch (e: any) {
    const status =
      e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    return res.status(status).json({
      error: e?.message || "Failed to update organization",
    });
  }
}

async function deleteOrgById(req: Request, res: Response) {
  try {
    const email = req.console?.email;
    if (!email) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Missing console email",
      });
    }

    const { orgId } = req.params;
    if (!orgId) {
      return res.status(400).json({ error: "Organization ID is required" });
    }

    const mod = await import("../../services/console/orgs.service");
    await mod.deleteOrg(email, orgId);

    return res.json({ success: true, message: "Organization deleted" });
  } catch (e: any) {
    const status =
      e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    return res.status(status).json({
      error: e?.message || "Failed to delete organization",
    });
  }
}

async function inviteMember(req: Request, res: Response) {
  try {
    const email = req.console?.email;
    if (!email) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Missing console email",
      });
    }

    const { orgId } = req.params;
    const { email: inviteeEmail, role } = req.body || {};
    if (!orgId) {
      return res.status(400).json({ error: "Organization ID is required" });
    }
    if (!inviteeEmail || typeof inviteeEmail !== "string") {
      return res.status(400).json({ error: "Invitee email is required" });
    }

    const mod = await import("../../services/console/orgs.service");
    const result = await mod.inviteMember(email, orgId, inviteeEmail, role);

    return res.status(201).json({ success: true, data: result });
  } catch (e: any) {
    const status =
      e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    return res.status(status).json({
      error: e?.message || "Failed to invite member",
    });
  }
}

async function changeMemberRole(req: Request, res: Response) {
  try {
    const email = req.console?.email;
    if (!email) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Missing console email",
      });
    }

    const { orgId, memberId } = req.params;
    const { role } = req.body || {};
    if (!orgId || !memberId) {
      return res.status(400).json({ error: "orgId and memberId are required" });
    }
    if (!role || (role !== "admin" && role !== "member")) {
      return res
        .status(400)
        .json({ error: "role is required and must be 'admin' or 'member'" });
    }

    const mod = await import("../../services/console/orgs.service");
    const org = await mod.changeMemberRole(email, orgId, memberId, role);

    return res.json({ success: true, data: org });
  } catch (e: any) {
    const status =
      e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    return res.status(status).json({
      error: e?.message || "Failed to change member role",
    });
  }
}

async function removeMember(req: Request, res: Response) {
  try {
    const email = req.console?.email;
    if (!email) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Missing console email",
      });
    }

    const { orgId, memberId } = req.params;
    if (!orgId || !memberId) {
      return res.status(400).json({ error: "orgId and memberId are required" });
    }

    const mod = await import("../../services/console/orgs.service");
    await mod.removeMember(email, orgId, memberId);

    return res.json({ success: true, message: "Member removed" });
  } catch (e: any) {
    const status =
      e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    return res.status(status).json({
      error: e?.message || "Failed to remove member",
    });
  }
}

async function acceptInvite(req: Request, res: Response) {
  try {
    const email = req.console?.email;
    if (!email) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Missing console email",
      });
    }

    const { token } = req.params;
    if (!token) {
      return res.status(400).json({ error: "Invite token is required" });
    }

    const mod = await import("../../services/console/orgs.service");
    const org = await mod.acceptInvite(email, token);

    return res.json({ success: true, data: org });
  } catch (e: any) {
    const status =
      e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    return res.status(status).json({
      error: e?.message || "Failed to accept invitation",
    });
  }
}

async function resendInviteEmail(req: Request, res: Response) {
  try {
    const email = req.console?.email;
    if (!email) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Missing console email",
      });
    }

    const { orgId } = req.params;
    const { email: inviteeEmail } = req.body || {};
    if (!orgId) {
      return res.status(400).json({ error: "Organization ID is required" });
    }
    if (!inviteeEmail || typeof inviteeEmail !== "string") {
      return res.status(400).json({ error: "Invitee email is required" });
    }

    const mod = await import("../../services/console/orgs.service");
    await mod.resendInvite(email, orgId, inviteeEmail);

    return res.json({ success: true, message: "Invitation resent" });
  } catch (e: any) {
    const status =
      e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    return res.status(status).json({
      error: e?.message || "Failed to resend invitation",
    });
  }
}

async function rescindInviteEmail(req: Request, res: Response) {
  try {
    const email = req.console?.email;
    if (!email) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Missing console email",
      });
    }

    const { orgId } = req.params;
    const { email: inviteeEmail } = req.body || {};
    if (!orgId) {
      return res.status(400).json({ error: "Organization ID is required" });
    }
    if (!inviteeEmail || typeof inviteeEmail !== "string") {
      return res.status(400).json({ error: "Invitee email is required" });
    }

    const mod = await import("../../services/console/orgs.service");
    await mod.rescindInvite(email, orgId, inviteeEmail);

    return res.json({ success: true, message: "Invitation rescinded" });
  } catch (e: any) {
    const status =
      e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    return res.status(status).json({
      error: e?.message || "Failed to rescind invitation",
    });
  }
}

export default router;
