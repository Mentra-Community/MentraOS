/**
 * @fileoverview Hono store auth API routes.
 * Authentication endpoints for the MentraOS Store website.
 * Mounted at: /api/store/auth
 */

import { Hono } from "hono";
import jwt from "jsonwebtoken";
import { tokenService } from "../../../services/core/temp-token.service";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "store.auth.api" });

const app = new Hono<AppEnv>();

// Environment variables
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || "";
const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";

// ============================================================================
// Routes
// ============================================================================

app.post("/exchange-token", exchangeToken);
app.post("/exchange-store-token", exchangeStoreToken);

// ============================================================================
// Handlers
// ============================================================================

/**
 * POST /api/store/auth/exchange-token
 * Exchange a Supabase token for a core token.
 * Body: { supabaseToken: string }
 */
async function exchangeToken(c: AppContext) {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { supabaseToken } = body as { supabaseToken?: string };

    if (!supabaseToken) {
      return c.json({ error: "No supabaseToken provided" }, 400);
    }

    logger.debug("Verifying Supabase token...");
    const decoded = jwt.verify(supabaseToken, SUPABASE_JWT_SECRET) as jwt.JwtPayload;
    const subject = decoded.sub;
    const email = decoded.email;

    if (!email) {
      return c.json({ error: "Email not found in token" }, 400);
    }

    const { User } = await import("../../../models/user.model");
    const user = await User.findOrCreateUser(email);

    const tokenData = {
      sub: subject,
      email: email,
      organizations: user.organizations || [],
      defaultOrg: user.defaultOrg || null,
    };

    const coreToken = jwt.sign(tokenData, AUGMENTOS_AUTH_JWT_SECRET);
    return c.json({ coreToken });
  } catch (error) {
    logger.error(error, "Token verification error");
    return c.json({ error: "Invalid token" }, 401);
  }
}

/**
 * POST /api/store/auth/exchange-store-token
 * Exchange a temporary token for full authentication tokens (for store webview).
 * Body: { aos_temp_token: string, packageName: string }
 */
async function exchangeStoreToken(c: AppContext) {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { aos_temp_token, packageName } = body as {
      aos_temp_token?: string;
      packageName?: string;
    };

    if (!aos_temp_token) {
      return c.json({ success: false, error: "Missing aos_temp_token" }, 400);
    }

    if (packageName !== "org.augmentos.store") {
      return c.json(
        {
          success: false,
          error: "Invalid package name for this endpoint",
        },
        403,
      );
    }

    const result = await tokenService.exchangeTemporaryToken(aos_temp_token, packageName);

    if (!result) {
      return c.json(
        {
          success: false,
          error: "Invalid or expired token",
        },
        401,
      );
    }

    const { User } = await import("../../../models/user.model");
    const user = await User.findByEmail(result.userId);

    const userData = {
      sub: result.userId,
      email: result.userId,
      organizations: user?.organizations || [],
      defaultOrg: user?.defaultOrg || null,
    };

    const coreToken = jwt.sign(userData, AUGMENTOS_AUTH_JWT_SECRET);

    return c.json({
      success: true,
      userId: result.userId,
      tokens: {
        coreToken,
      },
    });
  } catch (error) {
    logger.error(error, "Failed to exchange store token");
    return c.json(
      {
        success: false,
        error: "Failed to exchange token",
      },
      500,
    );
  }
}

export default app;
