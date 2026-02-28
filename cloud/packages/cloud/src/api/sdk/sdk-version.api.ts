/**
 * SDK Version API
 *
 * Base: /api/sdk/version
 * Endpoints:
 * - GET /        -> returns required SDK version (from server) and latest SDK version (from npm)
 *
 * Returns JSON:
 * {
 *   success: boolean,
 *   data: { required: string, latest: string },
 *   timestamp: string
 * }
 */

import { Router, Request, Response } from "express";
import { SDK_VERSIONS } from "../../version";

const router = Router();

// Routes (declare at top; handlers defined below)
router.get("/", getVersionHandler);

// Handlers (function declarations - hoisted)
async function getVersionHandler(req: Request, res: Response) {
  try {
    const response = await fetch(
      "https://registry.npmjs.org/@mentra/sdk/latest",
    );
    const npmSdkRes = await response.json();

    const data = {
      success: true,
      data: {
        required: SDK_VERSIONS.required,
        latest: npmSdkRes.version,
      },
      timestamp: new Date().toISOString(),
    };

    return res.json(data);
  } catch (error) {
    // Log and return server error (keep behavior explicit for ops)
    console.error("Failed to fetch SDK latest version from npm:", error);
    return res.status(500).json({ error: "Failed to fetch SDK version" });
  }
}

export default router;
