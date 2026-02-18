/**
 * CLI API Keys Service
 *
 * Business logic for CLI key management
 */

import * as jwt from "jsonwebtoken";
import * as crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import CLIKey from "../../models/cli-key.model";
import { User } from "../../models/user.model";
import {
  GenerateCLIKeyRequest,
  GenerateCLIKeyResponse,
  CLIApiKeyListItem,
  CLITokenPayload,
} from "@mentra/types";
import { logger as rootLogger } from "../logging/pino-logger";

const logger = rootLogger.child({ service: "cli-keys.service" });

const CLI_JWT_SECRET =
  process.env.CLI_AUTH_JWT_SECRET ||
  process.env.CONSOLE_AUTH_JWT_SECRET ||
  process.env.AUGMENTOS_AUTH_JWT_SECRET ||
  "";

/**
 * Generate a new CLI API key for a user
 */
export async function generateKey(
  email: string,
  request: GenerateCLIKeyRequest,
  metadata?: { createdFrom?: string; userAgent?: string },
): Promise<GenerateCLIKeyResponse> {
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) throw new Error("User not found");

  if (!request.name?.trim()) throw new Error("Key name is required");

  // Check duplicate name
  const existing = await CLIKey.findOne({
    userId: user._id,
    name: request.name,
    isActive: true,
  });
  if (existing) throw new Error(`Key "${request.name}" already exists`);

  const keyId = uuidv4();

  // Calculate expiration
  let expiresAt: Date | undefined;
  let exp: number | undefined;
  if (request.expiresInDays) {
    expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + request.expiresInDays);
    exp = Math.floor(expiresAt.getTime() / 1000);
  }

  // Generate JWT
  const payload: CLITokenPayload = {
    email: user.email,
    type: "cli",
    keyId,
    name: request.name,
    iat: Math.floor(Date.now() / 1000),
    ...(exp !== undefined && { exp }),
  };

  const token = jwt.sign(payload, CLI_JWT_SECRET);
  const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

  // Store in DB
  const cliKey = await CLIKey.create({
    keyId,
    userId: user._id,
    email: user.email,
    name: request.name,
    hashedToken,
    expiresAt,
    isActive: true,
    metadata,
  });

  logger.info(
    {
      keyId,
      userId: user._id.toString(),
      email: user.email,
      name: request.name,
    },
    "CLI key generated",
  );

  return {
    keyId: cliKey.keyId,
    name: cliKey.name,
    token,
    createdAt: cliKey.createdAt.toISOString(),
    expiresAt: cliKey.expiresAt?.toISOString(),
  };
}

/**
 * List all CLI keys for a user (by email - current pattern)
 */
export async function listKeys(email: string): Promise<CLIApiKeyListItem[]> {
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) throw new Error("User not found");

  // Query by userId (preferred) but have email as fallback
  const keys = await CLIKey.find({ userId: user._id }).sort({ createdAt: -1 });

  return keys.map((key) => ({
    keyId: key.keyId,
    name: key.name,
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString(),
    expiresAt: key.expiresAt?.toISOString(),
    isActive: key.isActive,
  }));
}

/**
 * Get specific CLI key details
 */
export async function getKey(
  email: string,
  keyId: string,
): Promise<CLIApiKeyListItem> {
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) throw new Error("User not found");

  const key = await CLIKey.findOne({ keyId, userId: user._id });
  if (!key) throw new Error("Key not found");

  return {
    keyId: key.keyId,
    name: key.name,
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString(),
    expiresAt: key.expiresAt?.toISOString(),
    isActive: key.isActive,
  };
}

/**
 * Update CLI key (rename)
 */
export async function updateKey(
  email: string,
  keyId: string,
  name: string,
): Promise<CLIApiKeyListItem> {
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) throw new Error("User not found");

  const key = await CLIKey.findOne({ keyId, userId: user._id });
  if (!key) throw new Error("Key not found");

  key.name = name.trim();
  await key.save();

  logger.info(
    { keyId, userId: user._id.toString(), email: user.email, newName: name },
    "CLI key renamed",
  );

  return {
    keyId: key.keyId,
    name: key.name,
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString(),
    expiresAt: key.expiresAt?.toISOString(),
    isActive: key.isActive,
  };
}

/**
 * Revoke CLI key (soft delete)
 */
export async function revokeKey(
  email: string,
  keyId: string,
): Promise<{ success: boolean }> {
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) throw new Error("User not found");

  const result = await CLIKey.updateOne(
    { keyId, userId: user._id, isActive: true },
    { $set: { isActive: false, updatedAt: new Date() } },
  );

  if (result.modifiedCount === 0) {
    throw new Error("Key not found or already revoked");
  }

  logger.info(
    { keyId, userId: user._id.toString(), email: user.email },
    "CLI key revoked",
  );

  return { success: true };
}

/**
 * Validate a CLI token and check if it's active
 * Used by CLI middleware
 */
export async function validateToken(
  token: string,
  payload: CLITokenPayload,
): Promise<boolean> {
  const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

  const key = await CLIKey.findOne({ keyId: payload.keyId, hashedToken });
  if (!key) {
    logger.warn({ keyId: payload.keyId }, "CLI key not found in database");
    return false;
  }

  // Check if key is valid (active and not expired)
  if (!key.isActive) {
    logger.warn({ keyId: payload.keyId }, "CLI key is not active");
    return false;
  }

  if (key.expiresAt && key.expiresAt < new Date()) {
    logger.warn(
      { keyId: payload.keyId, expiresAt: key.expiresAt },
      "CLI key is expired",
    );
    return false;
  }

  // Verify email matches
  if (key.email.toLowerCase() !== payload.email.toLowerCase()) {
    logger.warn(
      {
        keyId: payload.keyId,
        keyEmail: key.email,
        tokenEmail: payload.email,
      },
      "CLI key email mismatch",
    );
    return false;
  }

  // Track usage (async, don't wait)
  CLIKey.updateOne(
    { keyId: payload.keyId },
    { $set: { lastUsedAt: new Date() } },
  ).catch((err: unknown) => logger.error(err, "Failed to track CLI key usage"));

  return true;
}

/**
 * Cleanup expired keys (cron job)
 */
export async function cleanupExpiredKeys(): Promise<number> {
  const result = await CLIKey.updateMany(
    {
      expiresAt: { $lt: new Date() },
      isActive: true,
    },
    { $set: { isActive: false } },
  );

  const count = result.modifiedCount;
  if (count > 0) {
    logger.info({ count }, "Cleaned up expired CLI keys");
  }
  return count;
}

/**
 * Revoke all keys for a user (security feature)
 */
export async function revokeAllUserKeys(email: string): Promise<number> {
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) throw new Error("User not found");

  const result = await CLIKey.updateMany(
    { userId: user._id, isActive: true },
    { $set: { isActive: false } },
  );

  const count = result.modifiedCount;
  logger.info(
    { userId: user._id.toString(), email: user.email, count },
    "Revoked all CLI keys for user",
  );

  return count;
}
