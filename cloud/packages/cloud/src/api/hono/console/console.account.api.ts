/**
 * @fileoverview Hono console account API routes.
 * Console account endpoints for authenticated console users.
 * Mounted at: /api/console/account
 */

import { Hono } from "hono";
import ConsoleAccountService from "../../../services/console/console.account.service";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "console.account.api" });

const app = new Hono<AppEnv>();

// ============================================================================
// Routes
// ============================================================================

app.get("/", getConsoleAccount);

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /api/console/account
 * Get the console account details for the authenticated user.
 */
async function getConsoleAccount(c: AppContext) {
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

    const consoleAccount = await ConsoleAccountService.getConsoleAccount(email);

    return c.json({ success: true, data: consoleAccount });
  } catch (e: any) {
    const status = e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    logger.error(e, "Failed to fetch console account");
    return c.json(
      {
        error: e?.message || "Failed to fetch account",
      },
      status,
    );
  }
}

export default app;
