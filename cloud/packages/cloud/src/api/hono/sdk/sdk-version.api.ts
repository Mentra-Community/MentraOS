/**
 * @fileoverview Hono SDK version API routes.
 * Returns required SDK version (from server) and latest SDK version (from npm).
 * Mounted at: /api/sdk/version
 *
 * Supports dist-tag-aware version checking via the `tag` query parameter.
 * This prevents developers on non-latest tracks (beta, hono, etc.) from being
 * told to install @latest, which would downgrade/brick their app.
 *
 * Examples:
 *   GET /api/sdk/version           → returns latest stable version
 *   GET /api/sdk/version?tag=hono  → returns latest hono track version
 *   GET /api/sdk/version?tag=beta  → returns latest beta track version
 */

import { Hono } from "hono";
import { SDK_VERSIONS } from "../../../version";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "sdk-version.api" });

/**
 * Allowed npm dist-tags for @mentra/sdk.
 * Validated before use in the npm registry URL to prevent misuse.
 * Keep this list in sync with the tags published on npm.
 */
const ALLOWED_DIST_TAGS = new Set(["latest", "beta", "alpha", "hono", "rc", "canary", "next"]);

const app = new Hono<AppEnv>();

// ============================================================================
// Routes
// ============================================================================

app.get("/", getVersionHandler);

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /api/sdk/version
 * Returns required SDK version (from server) and latest SDK version (from npm).
 *
 * Query params:
 *   tag - npm dist-tag to check (default: "latest")
 *         Must be one of the allowed tags. Unknown tags fall back to "latest".
 *
 * Response:
 * {
 *   success: boolean,
 *   data: { required: string, latest: string, tag: string },
 *   timestamp: string
 * }
 */
async function getVersionHandler(c: AppContext) {
  try {
    // Parse and validate the requested dist-tag
    const requestedTag = c.req.query("tag") || "latest";
    const tag = ALLOWED_DIST_TAGS.has(requestedTag) ? requestedTag : "latest";

    if (requestedTag !== tag) {
      logger.debug({ requestedTag, resolvedTag: tag }, "Unknown dist-tag requested, falling back to latest");
    }

    const response = await fetch(`https://registry.npmjs.org/@mentra/sdk/${tag}`);

    if (!response.ok) {
      // If the tag doesn't exist on npm (e.g., tag was valid in our list
      // but hasn't been published yet), fall back to latest
      logger.warn(
        { tag, status: response.status },
        `npm registry returned ${response.status} for dist-tag "${tag}", falling back to latest`,
      );

      const fallbackResponse = await fetch("https://registry.npmjs.org/@mentra/sdk/latest");
      const fallbackData = (await fallbackResponse.json()) as {
        version: string;
      };

      return c.json({
        success: true,
        data: {
          required: SDK_VERSIONS.required,
          latest: fallbackData.version,
          tag: "latest",
        },
        timestamp: new Date().toISOString(),
      });
    }

    const npmSdkRes = (await response.json()) as { version: string };

    return c.json({
      success: true,
      data: {
        required: SDK_VERSIONS.required,
        latest: npmSdkRes.version,
        tag,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error(error, "Failed to fetch SDK version from npm");
    return c.json({ error: "Failed to fetch SDK version" }, 500);
  }
}

export default app;
