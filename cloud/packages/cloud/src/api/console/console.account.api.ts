/**
 * Console API (Skeleton)
 *
 * Base: /api/console/account
 * Mount: app.use("/api/console/account", authenticateConsole, consoleAccountApi)
 *
 * Sub-resources and endpoints (to be moved into dedicated files):
 *
 * Auth (console.account.api)
 * - GET    /
 */

import { Router, Request, Response } from "express";
import ConsoleAccountService from "../../services/console/console.account.service";
const router = Router();

/**
 * Routes — declared first, handlers below (function declarations are hoisted)
 * NOTE: No per-route middleware - authenticateConsole applied at mount point
 */

// Account
router.get("/", getConsoleAccount);

// Auth
async function getConsoleAccount(req: Request, res: Response) {
  try {
    const email = req.console?.email;
    if (!email) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Missing console email",
      });
    }

    const consoleAccount = await ConsoleAccountService.getConsoleAccount(email);

    return res.json({ success: true, data: consoleAccount });
  } catch (e: any) {
    const status =
      e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    return res.status(status).json({
      error: e?.message || "Failed to fetch account",
    });
  }
}

export default router;
