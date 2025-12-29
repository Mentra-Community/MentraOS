// cloud/src/api/client/min-version.api.ts
// API endpoints for checking client minimum versions

import { Router, Request, Response } from "express";

import { logger } from "../../services/logging/pino-logger";
import { CLIENT_VERSIONS } from "../../version";

const router = Router();

// API Endpoints // /api/client/min-version/*
router.get("/", getClientMinVersions);

// Handler functions
// Get client minimum versions
async function getClientMinVersions(req: Request, res: Response) {
  try {
    // Disable caching to prevent 304 responses that cause JSON parse errors on mobile
    // See: cloud/issues/015-http-304-etag-caching-bug
    //
    // We send response manually to avoid Express auto-adding ETag header
    // res.json() automatically adds ETag which causes 304 responses
    const body = JSON.stringify({
      success: true,
      data: CLIENT_VERSIONS,
      timestamp: new Date(),
    });
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Content-Type", "application/json; charset=utf-8");
    res.set("Content-Length", Buffer.byteLength(body).toString());
    res.status(200).send(body);
  } catch (error) {
    logger.error(error, `Error getting client minimum versions`);
    res.status(500).json({
      success: false,
      message: "Failed to get client minimum versions",
      timestamp: new Date(),
    });
  }
}

export default router;
