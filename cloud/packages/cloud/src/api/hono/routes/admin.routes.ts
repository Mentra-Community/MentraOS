/**
 * @fileoverview Hono admin routes.
 * Admin dashboard and app review endpoints.
 * Mounted at: /api/admin
 */

import { Hono } from "hono";
import jwt from "jsonwebtoken";
import { Readable } from "node:stream";
import v8 from "node:v8";
import os from "os";
import path from "path";
import App, { AppI } from "../../../models/app.model";
import { Organization } from "../../../models/organization.model";
import { memoryTelemetryService } from "../../../services/debug/MemoryTelemetryService";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import type { AppEnv, AppContext } from "../../../types/hono";
import { isMentraAdmin } from "../../../services/core/admin.utils";
import { appCache } from "../../../services/core/app-cache.service";
import { LeanDocument, Types } from "mongoose";

const logger = rootLogger.child({ service: "admin.routes" });

const app = new Hono<AppEnv>();

const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";

interface EnhancedApp extends LeanDocument<AppI & { _id: Types.ObjectId }> {
  organizationName?: string;
  organizationProfile?: {
    contactEmail?: string;
    logo?: string;
    description?: string;
  };
}

// ============================================================================
// Routes
// ============================================================================

// Public debug route - no auth required
app.get("/debug", getDebugInfo);

// Development only route
app.post("/create-test-submission", createTestSubmission);

// Admin check route
app.get("/check", validateAdminEmail, adminCheck);

// Admin stats and app management
app.get("/apps/stats", validateAdminEmail, getAdminStats);
app.get("/apps/submitted", validateAdminEmail, getSubmittedApps);
app.get("/apps/:packageName", validateAdminEmail, getAppDetail);
app.post("/apps/:packageName/approve", validateAdminEmail, approveApp);
app.post("/apps/:packageName/reject", validateAdminEmail, rejectApp);

// Memory telemetry routes
app.get("/memory/now", validateAdminEmail, getMemorySnapshot);
app.post("/memory/heap-snapshot", validateAdminEmail, takeHeapSnapshotHandler);
app.get("/memory/heap-snapshot-v8", validateAdminEmail, downloadHeapSnapshotHandler);

// Bun/JSC-native heap snapshot — returns JSON directly for local scripts/Safari-style
// tooling. For Chrome DevTools, use /memory/heap-snapshot-v8 instead.
app.get("/memory/heap-snapshot-bun", validateAdminEmail, (c: AppContext) => {
  try {
    const snapshot = Bun.generateHeapSnapshot();
    return c.json(snapshot);
  } catch (error) {
    logger.error(error, "Failed to generate Bun heap snapshot");
    return c.json({ error: "Failed to generate heap snapshot" }, 500);
  }
});

// ============================================================================
// Middleware
// ============================================================================

/**
 * Middleware to validate admin email.
 * Checks JWT token and verifies email belongs to a Mentra admin
 * (@mentra.glass, @mentraglass.com, or in ADMIN_EMAILS env var).
 */
async function validateAdminEmail(c: AppContext, next: () => Promise<void>) {
  const authHeader = c.req.header("authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, AUGMENTOS_AUTH_JWT_SECRET) as jwt.JwtPayload;

    if (!decoded || !decoded.email) {
      return c.json({ error: "Invalid token data" }, 401);
    }

    const email = decoded.email.toLowerCase();

    if (!isMentraAdmin(email)) {
      logger.warn({ email }, "Non-admin user attempted admin access");
      return c.json({ error: "Unauthorized - Admin access required" }, 403);
    }

    c.set("email", email);
    await next();
  } catch (error) {
    logger.debug({ error }, "Admin token verification failed");
    return c.json({ error: "Invalid or expired token" }, 401);
  }
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /api/admin/check
 * Verify if user is an admin.
 */
async function adminCheck(c: AppContext) {
  const email = c.get("email");
  return c.json({
    isAdmin: true,
    role: "ADMIN",
    email,
  });
}

/**
 * GET /api/admin/debug
 * Public debug route to check database status - no auth required.
 */
async function getDebugInfo(c: AppContext) {
  try {
    const counts = {
      apps: {
        total: await App.countDocuments(),
        development: await App.countDocuments({ appStoreStatus: "DEVELOPMENT" }),
        submitted: await App.countDocuments({ appStoreStatus: "SUBMITTED" }),
        published: await App.countDocuments({ appStoreStatus: "PUBLISHED" }),
        rejected: await App.countDocuments({ appStoreStatus: "REJECTED" }),
      },
      organizations: {
        total: await Organization.countDocuments(),
      },
    };

    return c.json(
      {
        status: "Database connection working",
        time: new Date().toISOString(),
        counts,
      },
      200,
      {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Origin, X-Requested-With, Content-Type, Accept",
      },
    );
  } catch (error) {
    logger.error(error, "Error in debug route");
    return c.json(
      {
        error: "Error connecting to database",
        message: (error as Error).message,
      },
      500,
    );
  }
}

/**
 * POST /api/admin/create-test-submission
 * Create test submission for development purposes.
 */
async function createTestSubmission(c: AppContext) {
  if (process.env.NODE_ENV !== "development") {
    return c.json({ error: "This endpoint is only available in development mode" }, 403);
  }

  try {
    const testApp = new App({
      name: `Test App ${Math.floor(Math.random() * 1000)}`,
      packageName: `com.test.app${Date.now()}`,
      description: "This is a test app submission for development",
      appStoreStatus: "SUBMITTED",
      isPublic: true,
      appType: "AppWebView",
      hashedApiKey: "test-key-hash",
      logoURL: "https://placehold.co/100x100?text=Test",
    });

    await testApp.save();
    appCache.invalidate(); // fire-and-forget

    return c.json(
      {
        message: "Test app submission created",
        app: testApp,
      },
      201,
    );
  } catch (error) {
    logger.error(error, "Error creating test submission");
    return c.json(
      {
        error: "Error creating test submission",
        message: (error as Error).message,
      },
      500,
    );
  }
}

/**
 * GET /api/admin/apps/stats
 * Get admin dashboard stats.
 */
async function getAdminStats(c: AppContext) {
  try {
    const [developmentCount, submittedCount, publishedCount, rejectedCount] = await Promise.all([
      App.countDocuments({ appStoreStatus: "DEVELOPMENT" }),
      App.countDocuments({ appStoreStatus: "SUBMITTED" }),
      App.countDocuments({ appStoreStatus: "PUBLISHED" }),
      App.countDocuments({ appStoreStatus: "REJECTED" }),
    ]);

    const recentSubmissions = await App.find({ appStoreStatus: "SUBMITTED" }).sort({ updatedAt: -1 }).limit(5).lean();

    // Enhance submissions with organization info
    const enhancedSubmissions = await Promise.all(
      recentSubmissions.map(async (appDoc) => {
        try {
          if (appDoc.organizationId) {
            const org = await Organization.findById(appDoc.organizationId);
            if (org) {
              return {
                ...appDoc,
                organizationName: org.name,
                organizationProfile: org.profile,
              };
            }
          }
          return appDoc;
        } catch (error) {
          logger.error(error, `Error enhancing app ${appDoc.packageName} with org info`);
          return appDoc;
        }
      }),
    );

    return c.json({
      counts: {
        development: developmentCount,
        submitted: submittedCount,
        published: publishedCount,
        rejected: rejectedCount,
        admins: 0,
      },
      recentSubmissions: enhancedSubmissions,
    });
  } catch (error) {
    logger.error(error, "Error fetching admin stats");
    return c.json({ error: "Failed to fetch admin stats" }, 500);
  }
}

/**
 * GET /api/admin/apps/submitted
 * Get all submitted apps.
 */
async function getSubmittedApps(c: AppContext) {
  try {
    logger.info("Fetching submitted apps");

    const submittedApps = await App.find({ appStoreStatus: "SUBMITTED" }).sort({ updatedAt: -1 }).lean();

    // Enhance with organization info
    const enhancedApps = await Promise.all(
      submittedApps.map(async (appDoc) => {
        try {
          if (appDoc.organizationId) {
            const org = await Organization.findById(appDoc.organizationId);
            if (org) {
              return {
                ...appDoc,
                organizationName: org.name,
                organizationProfile: org.profile,
              };
            }
          }
          return appDoc;
        } catch (error) {
          logger.error(error, `Error enhancing app ${appDoc.packageName} with org info`);
          return appDoc;
        }
      }),
    );

    logger.info(`Found ${enhancedApps.length} submitted apps`);
    return c.json(enhancedApps);
  } catch (error) {
    logger.error(error, "Error fetching submitted apps");
    return c.json({ error: "Failed to fetch submitted apps" }, 500);
  }
}

/**
 * GET /api/admin/apps/:packageName
 * Get a specific app detail.
 */
async function getAppDetail(c: AppContext) {
  try {
    const packageName = c.req.param("packageName");

    if (!packageName) {
      return c.json({ error: "Missing required parameter: packageName" }, 400);
    }

    const appDoc = await App.findOne({ packageName }).lean();

    if (!appDoc) {
      return c.json({ error: "App not found" }, 404);
    }

    // Enhance with organization info if available
    let enhancedApp: EnhancedApp = { ...appDoc } as EnhancedApp;
    try {
      if (appDoc.organizationId) {
        const org = await Organization.findById(appDoc.organizationId);
        if (org) {
          enhancedApp = {
            ...appDoc,
            organizationName: org.name,
            organizationProfile: org.profile,
          } as EnhancedApp;
        }
      }
    } catch (error) {
      logger.error(error, `Error enhancing app ${appDoc.packageName} with org info`);
    }

    return c.json(enhancedApp);
  } catch (error) {
    logger.error(error, "Error fetching app detail");
    return c.json({ error: "Failed to fetch app detail" }, 500);
  }
}

/**
 * POST /api/admin/apps/:packageName/approve
 * Approve an app.
 */
async function approveApp(c: AppContext) {
  try {
    const packageName = c.req.param("packageName");
    if (!packageName) {
      return c.json({ error: "packageName parameter is required" }, 400);
    }
    const adminEmail = c.get("email");
    const body = await c.req.json().catch(() => ({}));
    const { notes } = body as { notes?: string };

    if (!packageName) {
      return c.json({ error: "Missing required parameter: packageName" }, 400);
    }

    if (!adminEmail) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const appDoc = await App.findOne({ packageName });

    if (!appDoc) {
      return c.json({ error: "App not found" }, 404);
    }

    if (appDoc.appStoreStatus !== "SUBMITTED") {
      return c.json({ error: "App is not in submitted state" }, 400);
    }

    // Update app status and store approval notes
    appDoc.appStoreStatus = "PUBLISHED";
    appDoc.reviewNotes = notes || "";
    appDoc.reviewedBy = adminEmail;
    appDoc.reviewedAt = new Date();

    await appDoc.save();
    appCache.invalidate(); // fire-and-forget

    // Send approval email to developer/organization contact (non-blocking)
    try {
      let recipientEmail: string | null = null;
      if (appDoc.organizationId) {
        const org = await Organization.findById(appDoc.organizationId);
        recipientEmail = org?.profile?.contactEmail || null;
      }
      if (!recipientEmail && appDoc.developerId) {
        recipientEmail = appDoc.developerId;
      }

      if (recipientEmail) {
        const { emailService } = await import("../../../services/email/resend.service");
        const result = await emailService.sendAppApprovalNotification(recipientEmail, appDoc.name, packageName, notes);
        if (result && result.error) {
          logger.warn(result.error, `Approval email send returned error for ${packageName}`);
        }
      } else {
        logger.warn({ packageName }, "No recipient email for approval email");
      }
    } catch (error) {
      logger.error(error, "Failed to send approval notification email");
    }

    return c.json({
      message: "App approved successfully",
      app: appDoc,
    });
  } catch (error) {
    logger.error(error, "Error approving app");
    return c.json({ error: "Failed to approve app" }, 500);
  }
}

/**
 * POST /api/admin/apps/:packageName/reject
 * Reject an app.
 */
async function rejectApp(c: AppContext) {
  try {
    const packageName = c.req.param("packageName");
    if (!packageName) {
      return c.json({ error: "packageName parameter is required" }, 400);
    }
    const adminEmail = c.get("email");
    const body = await c.req.json().catch(() => ({}));
    const { notes } = body as { notes?: string };

    if (!packageName) {
      return c.json({ error: "Missing required parameter: packageName" }, 400);
    }

    if (!adminEmail) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    if (!notes) {
      return c.json({ error: "Rejection notes are required" }, 400);
    }

    const appDoc = await App.findOne({ packageName });

    if (!appDoc) {
      return c.json({ error: "App not found" }, 404);
    }

    if (appDoc.appStoreStatus !== "SUBMITTED") {
      return c.json({ error: "App is not in submitted state" }, 400);
    }

    // Update app status and store rejection notes
    appDoc.appStoreStatus = "REJECTED";
    appDoc.reviewNotes = notes;
    appDoc.reviewedBy = adminEmail;
    appDoc.reviewedAt = new Date();

    await appDoc.save();
    appCache.invalidate(); // fire-and-forget

    // Send rejection email to developer/organization contact (non-blocking)
    try {
      let recipientEmail: string | null = null;
      if (appDoc.organizationId) {
        const org = await Organization.findById(appDoc.organizationId);
        recipientEmail = org?.profile?.contactEmail || null;
      }
      if (!recipientEmail && appDoc.developerId) {
        recipientEmail = appDoc.developerId;
      }

      if (recipientEmail) {
        const { emailService } = await import("../../../services/email/resend.service");
        const result = await emailService.sendAppRejectionNotification(
          recipientEmail,
          appDoc.name,
          packageName,
          notes,
          adminEmail,
        );
        if (result && result.error) {
          logger.warn(result.error, `Rejection email send returned error for ${packageName}`);
        }
      } else {
        logger.warn({ packageName }, "No recipient email for rejection email");
      }
    } catch (error) {
      logger.error(error, "Failed to send rejection notification email");
    }

    return c.json({
      message: "App rejected",
      app: appDoc,
    });
  } catch (error) {
    logger.error(error, "Error rejecting app");
    return c.json({ error: "Failed to reject app" }, 500);
  }
}

/**
 * GET /api/admin/memory/now
 * Get a point-in-time memory telemetry snapshot.
 */
async function getMemorySnapshot(c: AppContext) {
  try {
    const snapshot = memoryTelemetryService.getCurrentStats();
    return c.json(snapshot);
  } catch (error) {
    logger.error(error, "Error generating memory telemetry snapshot");
    return c.json({ error: "Failed to generate memory telemetry snapshot" }, 500);
  }
}

/**
 * Self-DoS guard for V8 heap snapshot endpoints. Both v8.getHeapSnapshot and
 * v8.writeHeapSnapshot are SYNCHRONOUS — they block the event loop for the
 * full snapshot generation (which scales with heap size) and require ~2× the
 * current heap in memory. Two concurrent requests would stack that 2×
 * allocation on top of an already stressed pod and can trigger OOM.
 *
 * Do NOT invoke these endpoints during an active degradation window. Taking
 * a snapshot while a pod is stalled/OOM-ing will extend the stall and can
 * push the pod past its memory limit before the snapshot finishes streaming.
 */
let heapSnapshotInFlight = false;

/**
 * POST /api/admin/memory/heap-snapshot
 * Trigger a Chrome-compatible V8 heap snapshot and write it to a temp file.
 *
 * WARNING: synchronous, blocks the event loop, requires ~2× heap in memory.
 * See `heapSnapshotInFlight` above — do not call during a degradation window.
 */
async function takeHeapSnapshotHandler(c: AppContext) {
  if (heapSnapshotInFlight) {
    return c.json({ error: "Heap snapshot already in progress" }, 429);
  }
  heapSnapshotInFlight = true;

  const filename = `heap-${Date.now()}.heapsnapshot`;
  const filePath = path.join(os.tmpdir(), filename);

  try {
    await takeHeapSnapshot(filePath);
    return c.json({
      message: "Heap snapshot created",
      filePath,
    });
  } catch (error) {
    logger.error(error, "Error taking heap snapshot");
    return c.json({ error: "Failed to take heap snapshot" }, 500);
  } finally {
    heapSnapshotInFlight = false;
  }
}

/**
 * GET /api/admin/memory/heap-snapshot-v8
 * Stream a Chrome-compatible V8 heap snapshot directly to the caller.
 *
 * WARNING: synchronous, blocks the event loop, requires ~2× heap in memory.
 * See `heapSnapshotInFlight` above — do not call during a degradation window.
 */
async function downloadHeapSnapshotHandler(c: AppContext) {
  if (heapSnapshotInFlight) {
    return c.json({ error: "Heap snapshot already in progress" }, 429);
  }
  heapSnapshotInFlight = true;

  let nodeStream: Readable;
  try {
    nodeStream = v8.getHeapSnapshot();
  } catch (error) {
    heapSnapshotInFlight = false;
    logger.error(error, "Error starting V8 heap snapshot");
    return c.json({ error: "Failed to stream heap snapshot" }, 500);
  }

  // Hold the flag until the stream fully drains (or errors). A slow client
  // transferring the ~25MB snapshot over seconds would otherwise let another
  // admin request trigger a second v8.getHeapSnapshot() while the first is
  // still buffered in memory — stacking the 2× heap allocation the guard is
  // meant to prevent. 'close' fires after both clean end and error, so it
  // covers every exit path. Use `once` so we never double-clear.
  const release = () => {
    heapSnapshotInFlight = false;
  };
  nodeStream.once("close", release);
  nodeStream.once("error", (err) => {
    logger.error(err, "Error during V8 heap snapshot stream");
    release();
  });

  const filename = `heap-${Date.now()}.heapsnapshot`;
  const snapshotStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;

  return c.body(snapshotStream, 200, {
    "Cache-Control": "no-store",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Type": "application/json",
  });
}

/**
 * Helper function to take a Chrome-compatible V8 heap snapshot.
 */
async function takeHeapSnapshot(filePath: string): Promise<void> {
  v8.writeHeapSnapshot(filePath);
}

export default app;
