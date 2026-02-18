/**
 * @fileoverview Hono console organizations API routes.
 * Console organization endpoints for authenticated console users.
 * Mounted at: /api/console/orgs
 */

import { Hono } from "hono";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "console.orgs.api" });

const app = new Hono<AppEnv>();

// ============================================================================
// Routes
// ============================================================================

app.get("/", listOrgs);
app.post("/", createOrg);
app.get("/:orgId", getOrgById);
app.put("/:orgId", updateOrgById);
app.delete("/:orgId", deleteOrgById);
app.post("/accept/:token", acceptInvite);
app.post("/:orgId/members", inviteMember);
app.delete("/:orgId/members/:memberId", removeMember);
app.patch("/:orgId/members/:memberId", changeMemberRole);
app.post("/:orgId/invites/resend", resendInviteEmail);
app.post("/:orgId/invites/rescind", rescindInviteEmail);

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /api/console/orgs
 * List organizations for the authenticated console user.
 */
async function listOrgs(c: AppContext) {
  try {
    const consoleAuth = c.get("console");
    const email = consoleAuth?.email;

    if (!email) {
      return c.json(
        {
          error: "Unauthorized",
          message: "Missing console email",
        },
        401,
      );
    }

    const mod = await import("../../../services/console/orgs.service");
    const orgs = await mod.listUserOrgs(email);

    return c.json({ success: true, data: orgs });
  } catch (e: any) {
    const status = e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    logger.error(e, "Failed to list organizations");
    return c.json(
      {
        error: e?.message || "Failed to list organizations",
      },
      status,
    );
  }
}

/**
 * POST /api/console/orgs
 * Create a new organization.
 */
async function createOrg(c: AppContext) {
  try {
    const consoleAuth = c.get("console");
    const email = consoleAuth?.email;

    if (!email) {
      return c.json(
        {
          error: "Unauthorized",
          message: "Missing console email",
        },
        401,
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const { name } = body as { name?: string };

    const mod = await import("../../../services/console/orgs.service");
    const org = await mod.createOrg(email, name || "Untitled Organization");

    return c.json({ success: true, data: org }, 201);
  } catch (e: any) {
    const status = e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    logger.error(e, "Failed to create organization");
    return c.json(
      {
        error: e?.message || "Failed to create organization",
      },
      status,
    );
  }
}

/**
 * GET /api/console/orgs/:orgId
 * Get organization details.
 */
async function getOrgById(c: AppContext) {
  try {
    const consoleAuth = c.get("console");
    const email = consoleAuth?.email;

    if (!email) {
      return c.json(
        {
          error: "Unauthorized",
          message: "Missing console email",
        },
        401,
      );
    }

    const orgId = c.req.param("orgId");
    if (!orgId) {
      return c.json({ error: "Organization ID is required" }, 400);
    }

    const mod = await import("../../../services/console/orgs.service");
    const org = await mod.getOrg(email, orgId);

    return c.json({ success: true, data: org });
  } catch (e: any) {
    const status = e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    logger.error(e, "Failed to fetch organization");
    return c.json(
      {
        error: e?.message || "Failed to fetch organization",
      },
      status,
    );
  }
}

/**
 * PUT /api/console/orgs/:orgId
 * Update organization details (admin only).
 */
async function updateOrgById(c: AppContext) {
  try {
    const consoleAuth = c.get("console");
    const email = consoleAuth?.email;

    if (!email) {
      return c.json(
        {
          error: "Unauthorized",
          message: "Missing console email",
        },
        401,
      );
    }

    const orgId = c.req.param("orgId");
    if (!orgId) {
      return c.json({ error: "Organization ID is required" }, 400);
    }

    const patch = await c.req.json().catch(() => ({}));

    const mod = await import("../../../services/console/orgs.service");
    const org = await mod.updateOrg(email, orgId, patch);

    return c.json({ success: true, data: org });
  } catch (e: any) {
    const status = e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    logger.error(e, "Failed to update organization");
    return c.json(
      {
        error: e?.message || "Failed to update organization",
      },
      status,
    );
  }
}

/**
 * DELETE /api/console/orgs/:orgId
 * Delete organization (admin only).
 */
async function deleteOrgById(c: AppContext) {
  try {
    const consoleAuth = c.get("console");
    const email = consoleAuth?.email;

    if (!email) {
      return c.json(
        {
          error: "Unauthorized",
          message: "Missing console email",
        },
        401,
      );
    }

    const orgId = c.req.param("orgId");
    if (!orgId) {
      return c.json({ error: "Organization ID is required" }, 400);
    }

    const mod = await import("../../../services/console/orgs.service");
    await mod.deleteOrg(email, orgId);

    return c.json({ success: true, message: "Organization deleted" });
  } catch (e: any) {
    const status = e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    logger.error(e, "Failed to delete organization");
    return c.json(
      {
        error: e?.message || "Failed to delete organization",
      },
      status,
    );
  }
}

/**
 * POST /api/console/orgs/:orgId/members
 * Invite a member to the organization (admin only).
 */
async function inviteMember(c: AppContext) {
  try {
    const consoleAuth = c.get("console");
    const email = consoleAuth?.email;

    if (!email) {
      return c.json(
        {
          error: "Unauthorized",
          message: "Missing console email",
        },
        401,
      );
    }

    const orgId = c.req.param("orgId");
    if (!orgId) {
      return c.json({ error: "Organization ID is required" }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const { email: inviteeEmail, role } = body as { email?: string; role?: "admin" | "member" };

    if (!inviteeEmail || typeof inviteeEmail !== "string") {
      return c.json({ error: "Invitee email is required" }, 400);
    }

    const mod = await import("../../../services/console/orgs.service");
    const result = await mod.inviteMember(email, orgId, inviteeEmail, role);

    return c.json({ success: true, data: result }, 201);
  } catch (e: any) {
    const status = e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    logger.error(e, "Failed to invite member");
    return c.json(
      {
        error: e?.message || "Failed to invite member",
      },
      status,
    );
  }
}

/**
 * PATCH /api/console/orgs/:orgId/members/:memberId
 * Change a member's role (admin only).
 */
async function changeMemberRole(c: AppContext) {
  try {
    const consoleAuth = c.get("console");
    const email = consoleAuth?.email;

    if (!email) {
      return c.json(
        {
          error: "Unauthorized",
          message: "Missing console email",
        },
        401,
      );
    }

    const orgId = c.req.param("orgId");
    const memberId = c.req.param("memberId");

    if (!orgId || !memberId) {
      return c.json({ error: "orgId and memberId are required" }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const { role } = body as { role?: string };

    if (!role || (role !== "admin" && role !== "member")) {
      return c.json({ error: "role is required and must be 'admin' or 'member'" }, 400);
    }

    const mod = await import("../../../services/console/orgs.service");
    const org = await mod.changeMemberRole(email, orgId, memberId, role);

    return c.json({ success: true, data: org });
  } catch (e: any) {
    const status = e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    logger.error(e, "Failed to change member role");
    return c.json(
      {
        error: e?.message || "Failed to change member role",
      },
      status,
    );
  }
}

/**
 * DELETE /api/console/orgs/:orgId/members/:memberId
 * Remove a member from the organization (admin only).
 */
async function removeMember(c: AppContext) {
  try {
    const consoleAuth = c.get("console");
    const email = consoleAuth?.email;

    if (!email) {
      return c.json(
        {
          error: "Unauthorized",
          message: "Missing console email",
        },
        401,
      );
    }

    const orgId = c.req.param("orgId");
    const memberId = c.req.param("memberId");

    if (!orgId || !memberId) {
      return c.json({ error: "orgId and memberId are required" }, 400);
    }

    const mod = await import("../../../services/console/orgs.service");
    await mod.removeMember(email, orgId, memberId);

    return c.json({ success: true, message: "Member removed" });
  } catch (e: any) {
    const status = e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    logger.error(e, "Failed to remove member");
    return c.json(
      {
        error: e?.message || "Failed to remove member",
      },
      status,
    );
  }
}

/**
 * POST /api/console/orgs/accept/:token
 * Accept an organization invitation.
 */
async function acceptInvite(c: AppContext) {
  try {
    const consoleAuth = c.get("console");
    const email = consoleAuth?.email;

    if (!email) {
      return c.json(
        {
          error: "Unauthorized",
          message: "Missing console email",
        },
        401,
      );
    }

    const token = c.req.param("token");
    if (!token) {
      return c.json({ error: "Invite token is required" }, 400);
    }

    const mod = await import("../../../services/console/orgs.service");
    const org = await mod.acceptInvite(email, token);

    return c.json({ success: true, data: org });
  } catch (e: any) {
    const status = e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    logger.error(e, "Failed to accept invitation");
    return c.json(
      {
        error: e?.message || "Failed to accept invitation",
      },
      status,
    );
  }
}

/**
 * POST /api/console/orgs/:orgId/invites/resend
 * Resend an invitation email (admin only).
 */
async function resendInviteEmail(c: AppContext) {
  try {
    const consoleAuth = c.get("console");
    const email = consoleAuth?.email;

    if (!email) {
      return c.json(
        {
          error: "Unauthorized",
          message: "Missing console email",
        },
        401,
      );
    }

    const orgId = c.req.param("orgId");
    if (!orgId) {
      return c.json({ error: "Organization ID is required" }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const { email: inviteeEmail } = body as { email?: string };

    if (!inviteeEmail || typeof inviteeEmail !== "string") {
      return c.json({ error: "Invitee email is required" }, 400);
    }

    const mod = await import("../../../services/console/orgs.service");
    await mod.resendInvite(email, orgId, inviteeEmail);

    return c.json({ success: true, message: "Invitation resent" });
  } catch (e: any) {
    const status = e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    logger.error(e, "Failed to resend invitation");
    return c.json(
      {
        error: e?.message || "Failed to resend invitation",
      },
      status,
    );
  }
}

/**
 * POST /api/console/orgs/:orgId/invites/rescind
 * Rescind an invitation (admin only).
 */
async function rescindInviteEmail(c: AppContext) {
  try {
    const consoleAuth = c.get("console");
    const email = consoleAuth?.email;

    if (!email) {
      return c.json(
        {
          error: "Unauthorized",
          message: "Missing console email",
        },
        401,
      );
    }

    const orgId = c.req.param("orgId");
    if (!orgId) {
      return c.json({ error: "Organization ID is required" }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const { email: inviteeEmail } = body as { email?: string };

    if (!inviteeEmail || typeof inviteeEmail !== "string") {
      return c.json({ error: "Invitee email is required" }, 400);
    }

    const mod = await import("../../../services/console/orgs.service");
    await mod.rescindInvite(email, orgId, inviteeEmail);

    return c.json({ success: true, message: "Invitation rescinded" });
  } catch (e: any) {
    const status = e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    logger.error(e, "Failed to rescind invitation");
    return c.json(
      {
        error: e?.message || "Failed to rescind invitation",
      },
      status,
    );
  }
}

export default app;
