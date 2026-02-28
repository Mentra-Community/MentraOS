/**
 * @fileoverview Service for developer console operations.
 * Handles API key management, JWT generation, and app creation.
 *
 * This is a stateless collection of functions for developer-specific operations,
 * extracted from app.service.ts to improve separation of concerns.
 */

import jwt from "jsonwebtoken";
import crypto from "crypto";
import { AppI } from "@mentra/sdk";
import App from "../../models/app.model";
import { logger as rootLogger } from "../logging/pino-logger";
import UserSession from "../session/UserSession";

const SERVICE_NAME = "developer.service";
const logger = rootLogger.child({ service: SERVICE_NAME });

// Environment variables
const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";

/**
 * Generate a hashed API key
 * @param apiKey - The API key to hash
 * @returns The hashed API key
 */
export function hashApiKey(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

/**
 * Generate a new API key for a App
 * @returns The generated API key
 */
export function generateApiKey(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Generate a JWT token for App authentication
 * This JWT contains both packageName and apiKey, allowing Apps to authenticate
 * with a single token instead of separate values.
 *
 * @param packageName - The package name of the App
 * @param apiKey - The API key for the App
 * @returns The JWT token
 */
export function generateAppJwt(packageName: string, apiKey: string): string {
  // Generate the JWT with packageName and apiKey
  return jwt.sign({ packageName, apiKey }, AUGMENTOS_AUTH_JWT_SECRET);
}

/**
 * Validate an API key for a App
 * @param packageName - The package name of the App
 * @param apiKey - The API key to validate
 * @param userSession - Optional user session for tying logs to a user.
 * @returns Whether the API key is valid
 */
export async function validateApiKey(
  packageName: string,
  apiKey: string,
  userSession?: UserSession,
): Promise<boolean> {
  const _logger = userSession
    ? userSession.logger.child({ service: SERVICE_NAME, packageName })
    : logger.child({ packageName });

  try {
    // Find the app in the database
    const app = await App.findOne({ packageName });
    if (!app) {
      _logger.error(`App not found for package: ${packageName}`);
      return false;
    }

    // Special validation for system apps.
    // Currently, only the system dashboard app is considered a system app.
    // const isSystemApp = packageName === 'system.augmentos.dashboard';

    // if (isSystemApp) {
    //   _logger.debug(`Validating SYSTEM APP API key for: ${packageName}`);

    //   // System app api key should be same as AUGMENTOS_AUTH_JWT_SECRET
    //   if (apiKey !== AUGMENTOS_AUTH_JWT_SECRET) {
    //     _logger.error(`Invalid API key for system app ${packageName}`);
    //     return false;
    //   }
    //   return true;
    // }

    // Check if the app has a hashed API key
    if (!app?.hashedApiKey) {
      _logger.warn(`App ${packageName} does not have a hashed API key`);
      return false;
    }

    // Hash the provided API key and compare with stored hash
    const hashedKey = hashApiKey(apiKey);

    _logger.debug(
      { hashedKey, apiKey },
      `Validating API key for ${packageName}`,
    );

    // Compare the hashed API key with the stored hashed API key
    const isValid = hashedKey === app.hashedApiKey;

    if (!isValid) {
      _logger.warn(`Invalid API key for package: ${packageName}`);
    }

    return isValid;
  } catch (error) {
    _logger.error(
      error as Error,
      `Error validating API key for ${packageName}:`,
    );
    return false;
  }
}

/**
 * Create a new app with JWT generation
 * Enhanced version of app.service.createApp that also generates a JWT
 *
 * @param appData - The app data
 * @param developerId - The developer ID
 * @returns The created app, API key, and JWT
 */
export async function createApp(
  appData: any,
  developerId: string,
): Promise<{ app: AppI; apiKey: string; jwt: string }> {
  try {
    // Generate API key
    const apiKey = generateApiKey();
    const hashedApiKey = hashApiKey(apiKey);

    // Parse and validate tools if present
    if (appData.tools) {
      try {
        validateToolDefinitions(appData.tools);
      } catch (error: any) {
        throw new Error(`Invalid tool definitions: ${error.message}`);
      }
    }

    // Determine organization domain if shared
    let organizationDomain = null;
    let sharedWithOrganization = false;
    let visibility: "private" | "organization" = "private";
    if (appData.sharedWithOrganization) {
      const emailParts = developerId.split("@");
      if (emailParts.length === 2) {
        organizationDomain = emailParts[1].toLowerCase();
        sharedWithOrganization = true;
        visibility = "organization";
      }
    }

    // Create app
    const app = await App.create({
      ...appData,
      developerId,
      organizationDomain,
      sharedWithOrganization,
      visibility,
      hashedApiKey,
    });

    // Generate JWT
    const jwt = generateAppJwt(app.packageName, apiKey);

    return {
      app,
      apiKey,
      jwt,
    };
  } catch (error) {
    logger.error(error as Error, `Error creating app:`);
    throw error;
  }
}

/**
 * Regenerate API key for an app with JWT generation
 * Enhanced version of app.service.regenerateApiKey that also generates a JWT
 *
 * @param packageName - The package name
 * @param developerId - The developer ID
 * @returns The new API key and JWT
 */
export async function regenerateApiKey(
  packageName: string,
  developerId: string,
): Promise<{ apiKey: string; jwt: string }> {
  try {
    // Ensure developer owns the app or is in the org if shared
    const app = await App.findOne({ packageName });
    if (!app) {
      throw new Error(`App with package name ${packageName} not found`);
    }
    if (!developerId) {
      throw new Error("Developer ID is required");
    }
    if (!app.developerId) {
      throw new Error("Developer ID not found for this app");
    }

    // Check if developer owns the app or is in the organization
    const isOwner = app.developerId.toString() === developerId;
    let isOrgMember = false;
    if (app.sharedWithOrganization && app.organizationDomain) {
      const emailParts = developerId.split("@");
      if (
        emailParts.length === 2 &&
        emailParts[1].toLowerCase() === app.organizationDomain
      ) {
        isOrgMember = true;
      }
    }

    if (!isOwner && !isOrgMember) {
      throw new Error("You do not have permission to update this app");
    }

    // Generate new API key
    const apiKey = generateApiKey();
    const hashedApiKey = hashApiKey(apiKey);

    // Update app with new hashed API key
    await App.findOneAndUpdate({ packageName }, { $set: { hashedApiKey } });

    // Generate JWT
    const jwt = generateAppJwt(packageName, apiKey);

    return {
      apiKey,
      jwt,
    };
  } catch (error) {
    logger.error(error as Error, `Error regenerating API key:`);
    throw error;
  }
}

/**
 * Validates tool definitions against the schema requirements
 * @param tools Array of tool definitions to validate
 * @returns Validated and sanitized tools array or throws error if invalid
 */
function validateToolDefinitions(tools: any[]): any[] {
  logger.debug({ tools }, "Validating tool definitions:");
  if (!Array.isArray(tools)) {
    throw new Error("Tools must be an array");
  }

  return tools.map((tool) => {
    // Validate required fields
    if (!tool.id || typeof tool.id !== "string") {
      throw new Error("Tool id is required and must be a string");
    }

    if (!tool.description || typeof tool.description !== "string") {
      throw new Error("Tool description is required and must be a string");
    }

    // Additional validation for parameters if present
    if (tool.parameters) {
      if (!Array.isArray(tool.parameters)) {
        throw new Error("Tool parameters must be an array");
      }

      tool.parameters = tool.parameters.map((param: any) => {
        if (!param.id || typeof param.id !== "string") {
          throw new Error("Parameter id is required and must be a string");
        }

        if (!param.type || typeof param.type !== "string") {
          throw new Error("Parameter type is required and must be a string");
        }

        return param;
      });
    }

    return tool;
  });
}

/**
 * Hash a string using an app's hashed API key
 * @param stringToHash - String to be hashed
 * @param packageName - Package name of the app to use its hashed API key
 * @returns Promise resolving to the resulting hash string
 */
export async function hashWithApiKey(
  stringToHash: string,
  packageName: string,
): Promise<string> {
  const app = await App.findOne({ packageName });

  if (!app || !app.hashedApiKey) {
    throw new Error(`App ${packageName} not found or has no API key`);
  }

  // Create a hash using the provided string and the app's hashed API key
  return crypto
    .createHash("sha256")
    .update(stringToHash)
    .update(app.hashedApiKey)
    .digest("hex");
}
