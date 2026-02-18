/**
 * @fileoverview Hono auth routes.
 * Authentication endpoints for token exchange and webview authentication.
 * Mounted at: /api/auth and /auth
 */

import { Hono } from "hono";
import jwt from "jsonwebtoken";
import { tokenService } from "../../../services/core/temp-token.service";
import appService from "../../../services/core/app.service";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "auth.routes" });

const app = new Hono<AppEnv>();

// Environment variables
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || "";
const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";
const AUTHING_APP_SECRET = process.env.AUTHING_APP_SECRET || "";
const JOE_MAMA_USER_JWT = process.env.JOE_MAMA_USER_JWT || "";

// ============================================================================
// Routes
// ============================================================================

app.post("/exchange-token", exchangeToken);
app.post("/generate-webview-token", validateCoreTokenMiddleware, generateWebviewToken);
app.post("/exchange-user-token", validateAppApiKeyMiddleware, exchangeUserToken);
app.post("/exchange-store-token", exchangeStoreToken);
app.post("/hash-with-api-key", validateCoreTokenMiddleware, hashWithApiKey);
app.post("/generate-webview-signed-user-token", validateCoreTokenMiddleware, generateWebviewSignedUserToken);

// ============================================================================
// Middleware
// ============================================================================

/**
 * Middleware to validate core token from Authorization header.
 * Sets c.set("email") on success.
 */
async function validateCoreTokenMiddleware(c: AppContext, next: () => Promise<void>) {
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

    c.set("email", decoded.email.toLowerCase());
    await next();
  } catch (error) {
    logger.error(error, "Core token verification failed");
    return c.json({ error: "Invalid or expired token" }, 401);
  }
}

/**
 * Middleware to validate App API key.
 * Expects Authorization: Bearer <packageName>:<apiKey>
 */
async function validateAppApiKeyMiddleware(c: AppContext, next: () => Promise<void>) {
  const authHeader = c.req.header("authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const token = authHeader.substring(7);
  const parts = token.split(":");

  if (parts.length !== 2) {
    return c.json({ error: "Invalid token format" }, 401);
  }

  const [packageName, apiKey] = parts;

  if (!packageName || !apiKey) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  // Validate API key
  const { validateApiKey } = await import("../../../services/sdk/sdk.auth.service");
  const isValid = await validateApiKey(packageName, apiKey);

  if (!isValid) {
    return c.json({ error: "Invalid API key" }, 401);
  }

  c.set("sdk", { packageName, apiKey });
  await next();
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * POST /auth/exchange-token
 * Exchange a Supabase or Authing token for a core token.
 */
async function exchangeToken(c: AppContext) {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { supabaseToken, authingToken } = body as {
      supabaseToken?: string;
      authingToken?: string;
    };

    if (!supabaseToken && !authingToken) {
      return c.json({ error: "No token provided" }, 400);
    }

    const { User } = await import("../../../models/user.model");

    if (supabaseToken) {
      logger.debug("Verifying Supabase token...");
      const decoded = jwt.verify(supabaseToken, SUPABASE_JWT_SECRET) as jwt.JwtPayload;
      const subject = decoded.sub;
      const email = decoded.email;

      const user = await User.findOrCreateUser(email);

      const newData = {
        sub: subject,
        email: email,
        organizations: user.organizations || [],
        defaultOrg: user.defaultOrg || null,
      };

      const coreToken = jwt.sign(newData, AUGMENTOS_AUTH_JWT_SECRET);
      return c.json({ coreToken });
    }

    if (authingToken) {
      logger.debug("Verifying Authing token...");
      const decoded = jwt.verify(authingToken, AUTHING_APP_SECRET) as jwt.JwtPayload;
      const subject = decoded.sub;
      const email = decoded.email;

      const user = await User.findOrCreateUser(email);

      const newData = {
        sub: subject,
        email: email,
        organizations: user.organizations || [],
        defaultOrg: user.defaultOrg || null,
      };

      const coreToken = jwt.sign(newData, AUGMENTOS_AUTH_JWT_SECRET);
      return c.json({ coreToken });
    }

    return c.json({ error: "No valid token provided" }, 400);
  } catch (error) {
    logger.error(error, "Token verification error");
    return c.json({ error: "Invalid token" }, 401);
  }
}

/**
 * POST /auth/generate-webview-token
 * Generate a temporary token for webview authentication.
 */
async function generateWebviewToken(c: AppContext) {
  const userId = c.get("email");

  try {
    const body = await c.req.json().catch(() => ({}));
    const { packageName } = body as { packageName?: string };

    if (!packageName) {
      return c.json({ success: false, error: "packageName is required" }, 400);
    }

    const tempToken = await tokenService.generateTemporaryToken(userId!, packageName);
    return c.json({ success: true, token: tempToken });
  } catch (error) {
    logger.error({ error, userId }, "Failed to generate webview token");
    return c.json({ success: false, error: "Failed to generate token" }, 500);
  }
}

/**
 * POST /auth/exchange-user-token
 * Exchange a temporary token for user details (called by App backend).
 */
async function exchangeUserToken(c: AppContext) {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { aos_temp_token, packageName } = body as {
      aos_temp_token?: string;
      packageName?: string;
    };

    if (!aos_temp_token) {
      return c.json({ success: false, error: "Missing aos_temp_token" }, 400);
    }

    const result = await tokenService.exchangeTemporaryToken(aos_temp_token, packageName || "");

    if (result) {
      return c.json({ success: true, userId: result.userId });
    } else {
      return c.json({ success: false, error: "Invalid or expired token" }, 401);
    }
  } catch (error) {
    logger.error(error, "Failed to exchange webview token");
    return c.json({ success: false, error: "Failed to exchange token" }, 500);
  }
}

/**
 * POST /auth/exchange-store-token
 * Exchange a temporary token for full tokens (for store webview).
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
      return c.json({ success: false, error: "Invalid package name for this endpoint" }, 403);
    }

    const result = await tokenService.exchangeTemporaryToken(aos_temp_token, packageName);

    if (result) {
      const supabaseToken = JOE_MAMA_USER_JWT;

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
          supabaseToken,
          coreToken,
        },
      });
    } else {
      return c.json({ success: false, error: "Invalid or expired token" }, 401);
    }
  } catch (error) {
    logger.error(error, "Failed to exchange store token");
    return c.json({ success: false, error: "Failed to exchange token" }, 500);
  }
}

/**
 * POST /auth/hash-with-api-key
 * Create a hash with the app's hashed API key.
 */
async function hashWithApiKey(c: AppContext) {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { stringToHash, packageName } = body as {
      stringToHash?: string;
      packageName?: string;
    };

    if (!stringToHash || !packageName) {
      return c.json({ success: false, error: "stringToHash and packageName are required" }, 400);
    }

    const hash = await appService.hashWithApiKey(stringToHash, packageName);
    return c.json({ success: true, hash });
  } catch (error) {
    logger.error(error, "Failed to hash string with API key");
    return c.json({ success: false, error: "Failed to generate hash" }, 500);
  }
}

/**
 * POST /auth/generate-webview-signed-user-token
 * Generate a signed JWT token for webview authentication in Apps.
 */
async function generateWebviewSignedUserToken(c: AppContext) {
  const userId = c.get("email");

  try {
    const body = await c.req.json().catch(() => ({}));
    const { packageName } = body as { packageName?: string };

    if (!packageName) {
      return c.json({ success: false, error: "packageName is required" }, 400);
    }

    const signedToken = await tokenService.issueUserToken(userId!, packageName);
    logger.debug("[auth.service] Signed user token generated");

    return c.json({
      success: true,
      token: signedToken,
      expiresIn: "10m",
    });
  } catch (error) {
    logger.error({ error, userId }, "[auth.service] Failed to generate signed webview user token");
    return c.json({ success: false, error: "Failed to generate token: " + error }, 500);
  }
}

export default app;
