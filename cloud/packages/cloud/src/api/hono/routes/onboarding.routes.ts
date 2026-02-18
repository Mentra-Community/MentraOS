/**
 * @fileoverview Hono onboarding routes.
 * Onboarding status and completion endpoints for apps.
 * Mounted at: /api/onboarding
 */

import { Hono } from "hono";
import { User } from "../../../models/user.model";
import App from "../../../models/app.model";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "onboarding.routes" });

const app = new Hono<AppEnv>();

// ============================================================================
// Routes
// ============================================================================

app.get("/status", getOnboardingStatus);
app.post("/complete", completeOnboarding);
app.get("/instructions", getOnboardingInstructions);

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /api/onboarding/status
 * Get onboarding status for a user and app.
 * Query params: email, packageName
 */
async function getOnboardingStatus(c: AppContext) {
  const email = c.req.query("email");
  const packageName = c.req.query("packageName");

  if (!email || !packageName) {
    return c.json({ error: "Missing email or packageName" }, 400);
  }

  try {
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }

    const appDoc = await App.findOne({ packageName });
    if (!appDoc) {
      return c.json({ error: "App not found" }, 404);
    }

    const userId = user._id.toString();
    let hasCompleted = false;

    if (appDoc.onboardingStatus && appDoc.onboardingStatus instanceof Map) {
      hasCompleted = !!appDoc.onboardingStatus.get(userId);
    } else if (appDoc.onboardingStatus && typeof appDoc.onboardingStatus === "object") {
      hasCompleted = !!(appDoc.onboardingStatus as Record<string, boolean>)[userId];
    }

    // If not found, set onboardingStatus for this user to false
    if (!hasCompleted) {
      const hasEntry =
        appDoc.onboardingStatus instanceof Map
          ? appDoc.onboardingStatus.has(userId)
          : appDoc.onboardingStatus && userId in appDoc.onboardingStatus;

      if (!hasEntry) {
        await App.updateOne({ _id: appDoc._id }, { $set: { [`onboardingStatus.${userId}`]: false } });
      }
    }

    return c.json({ hasCompletedOnboarding: hasCompleted });
  } catch (error) {
    logger.error(error, "Error getting onboarding status");
    return c.json({ error: "Internal server error" }, 500);
  }
}

/**
 * POST /api/onboarding/complete
 * Mark onboarding as complete for a user and app.
 * Body: { email, packageName }
 */
async function completeOnboarding(c: AppContext) {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { email, packageName } = body as { email?: string; packageName?: string };

    if (!email || !packageName) {
      return c.json({ error: "Missing email or packageName" }, 400);
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }

    // Update onboardingStatus for this user in the app
    await App.updateOne({ packageName }, { $set: { [`onboardingStatus.${user._id.toString()}`]: true } });

    // Reload the app to get the latest onboardingStatus
    const appDoc = await App.findOne({ packageName });
    let hasCompleted = false;

    if (appDoc && appDoc.onboardingStatus) {
      if (appDoc.onboardingStatus instanceof Map) {
        hasCompleted = !!appDoc.onboardingStatus.get(user._id.toString());
      } else if (typeof appDoc.onboardingStatus === "object") {
        hasCompleted = !!(appDoc.onboardingStatus as Record<string, boolean>)[user._id.toString()];
      }
    }

    return c.json({ success: true, hasCompletedOnboarding: hasCompleted });
  } catch (error) {
    logger.error(error, "Error completing onboarding");
    return c.json({ error: "Internal server error" }, 500);
  }
}

/**
 * GET /api/onboarding/instructions
 * Get onboarding instructions for an app.
 * Query params: packageName
 */
async function getOnboardingInstructions(c: AppContext) {
  const packageName = c.req.query("packageName");

  if (!packageName) {
    return c.json({ error: "Missing packageName" }, 400);
  }

  try {
    const appDoc = await App.findOne({ packageName });
    if (!appDoc || !appDoc.onboardingInstructions) {
      return c.json({ error: "No onboarding instructions found for this package" }, 404);
    }

    return c.json({ instructions: appDoc.onboardingInstructions });
  } catch (error) {
    logger.error(error, "Error getting onboarding instructions");
    return c.json({ error: "Internal server error" }, 500);
  }
}

export default app;
