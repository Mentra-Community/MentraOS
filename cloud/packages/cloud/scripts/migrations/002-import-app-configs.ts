/**
 * Migration script: Import App Configurations from Server Files
 *
 * This migration:
 * 1. Fetches all apps from the database
 * 2. For each app that has a publicUrl, attempts to fetch app_config.json from {publicUrl}/app_config.json
 * 3. Validates the configuration using the same logic as the frontend
 * 4. Updates the database with the imported configuration (settings, tools) only for fields that are currently empty/null/undefined
 * 5. Preserves existing database data - never overwrites non-empty settings or tools arrays
 *
 * Usage:
 * ts-node -r tsconfig-paths/register scripts/migrations/002-import-app-configs.ts
 *
 * Options:
 * --dry-run         Check what would happen without making changes
 * --package-filter  Only process apps with package name matching pattern (supports regex)
 * --timeout         HTTP timeout in seconds (default: 10)
 * --skip-ssl        Skip SSL certificate verification (use with caution)
 */

import mongoose from "mongoose";
import dotenv from "dotenv";
import https from "https";
import http from "http";
import { URL } from "url";
import App, { AppI } from "../../src/models/app.model";
import { logger as rootLogger } from "../../src/services/logging/pino-logger";
import { AppSetting, ToolSchema } from "@mentra/sdk";

// Configure environment
dotenv.config();

const logger = rootLogger.child({ migration: "002-import-app-configs" });
const DRY_RUN = process.argv.includes("--dry-run");
const SKIP_SSL = process.argv.includes("--skip-ssl");

// Parse command line arguments
const PACKAGE_FILTER_ARG = process.argv.find((arg) =>
  arg.startsWith("--package-filter="),
);
const PACKAGE_FILTER = PACKAGE_FILTER_ARG
  ? PACKAGE_FILTER_ARG.split("=")[1]
  : null;

const TIMEOUT_ARG = process.argv.find((arg) => arg.startsWith("--timeout="));
const TIMEOUT_SECONDS = TIMEOUT_ARG ? parseInt(TIMEOUT_ARG.split("=")[1]) : 10;

if (DRY_RUN) {
  logger.info("DRY RUN MODE: No changes will be made to the database");
}

if (PACKAGE_FILTER) {
  logger.info(
    `Package filter mode: Only processing apps with package name matching: ${PACKAGE_FILTER}`,
  );
}

if (SKIP_SSL) {
  logger.warn("SSL verification disabled - use with caution");
}

logger.info(`HTTP timeout set to ${TIMEOUT_SECONDS} seconds`);

/**
 * Interface for App configuration as expected from app_config.json
 * Only includes the fields we care about: settings and tools
 */
interface AppConfigFile {
  settings?: AppSetting[];
  tools?: ToolSchema[];
}

/**
 * Validates a App configuration object structure and returns detailed error information
 * Only validates settings and tools fields. Unknown setting types are filtered out rather than causing failure.
 * @param config - Object to validate
 * @returns Object with validation result, cleaned config, and specific error message
 */
function validateAppConfig(config: any): {
  isValid: boolean;
  error?: string;
  cleanedConfig?: AppConfigFile;
  skippedSettings?: Array<{ index: number; type: string; reason: string }>;
} {
  if (!config || typeof config !== "object") {
    return {
      isValid: false,
      error: "Configuration file must contain a valid JSON object.",
    };
  }

  const skippedSettings: Array<{
    index: number;
    type: string;
    reason: string;
  }> = [];
  const cleanedConfig: AppConfigFile = {};

  // Settings array is optional but must be an array if provided
  if (config.settings !== undefined && !Array.isArray(config.settings)) {
    return {
      isValid: false,
      error: 'Optional field "settings" must be an array if provided.',
    };
  }

  if (config.settings === undefined) {
    config.settings = [];
  }

  // Tools array is optional but must be an array if provided
  if (config.tools !== undefined && !Array.isArray(config.tools)) {
    return {
      isValid: false,
      error: 'Optional field "tools" must be an array if provided.',
    };
  }

  // Filter and validate settings
  const validSettings: AppSetting[] = [];

  for (let index = 0; index < config.settings.length; index++) {
    const setting = config.settings[index];

    // Group settings just need a title
    if (setting.type === "group") {
      if (typeof setting.title !== "string") {
        skippedSettings.push({
          index: index + 1,
          type: setting.type,
          reason: 'Group type requires a "title" field with a string value.',
        });
        continue;
      }
      validSettings.push(setting);
      continue;
    }

    // TITLE_VALUE settings just need label and value
    if (setting.type === "titleValue") {
      if (typeof setting.label !== "string") {
        skippedSettings.push({
          index: index + 1,
          type: setting.type,
          reason:
            'TitleValue type requires a "label" field with a string value.',
        });
        continue;
      }
      if (!("value" in setting)) {
        skippedSettings.push({
          index: index + 1,
          type: setting.type,
          reason: 'TitleValue type requires a "value" field.',
        });
        continue;
      }
      validSettings.push(setting);
      continue;
    }

    // Regular settings need key and label and type
    if (
      typeof setting.key !== "string" ||
      typeof setting.label !== "string" ||
      typeof setting.type !== "string"
    ) {
      skippedSettings.push({
        index: index + 1,
        type: setting.type || "unknown",
        reason:
          'Missing required fields "key", "label", or "type" (all must be strings).',
      });
      continue;
    }

    // Type-specific validation
    let isValidSetting = true;
    let skipReason = "";

    switch (setting.type) {
      case "toggle":
        if (
          setting.defaultValue !== undefined &&
          typeof setting.defaultValue !== "boolean"
        ) {
          isValidSetting = false;
          skipReason =
            'Toggle type requires "defaultValue" to be a boolean if provided.';
        }
        break;

      case "text":
      case "text_no_save_button":
        if (
          setting.defaultValue !== undefined &&
          typeof setting.defaultValue !== "string"
        ) {
          isValidSetting = false;
          skipReason =
            'Text type requires "defaultValue" to be a string if provided.';
        }
        break;

      case "select":
      case "select_with_search":
        if (!Array.isArray(setting.options)) {
          isValidSetting = false;
          skipReason = 'Select type requires an "options" array.';
        } else {
          for (
            let optIndex = 0;
            optIndex < setting.options.length;
            optIndex++
          ) {
            const opt = setting.options[optIndex];
            if (typeof opt.label !== "string" || !("value" in opt)) {
              isValidSetting = false;
              skipReason = `Option ${optIndex + 1}: Each option must have "label" (string) and "value" fields.`;
              break;
            }
          }
        }
        break;

      case "multiselect":
        if (!Array.isArray(setting.options)) {
          isValidSetting = false;
          skipReason = 'Multiselect type requires an "options" array.';
        } else {
          for (
            let optIndex = 0;
            optIndex < setting.options.length;
            optIndex++
          ) {
            const opt = setting.options[optIndex];
            if (typeof opt.label !== "string" || !("value" in opt)) {
              isValidSetting = false;
              skipReason = `Option ${optIndex + 1}: Each option must have "label" (string) and "value" fields.`;
              break;
            }
          }
          if (
            isValidSetting &&
            setting.defaultValue !== undefined &&
            !Array.isArray(setting.defaultValue)
          ) {
            isValidSetting = false;
            skipReason =
              'Multiselect type requires "defaultValue" to be an array if provided.';
          }
        }
        break;

      case "slider":
        if (
          typeof setting.defaultValue !== "number" ||
          typeof setting.min !== "number" ||
          typeof setting.max !== "number" ||
          setting.min > setting.max
        ) {
          isValidSetting = false;
          skipReason =
            'Slider type requires "defaultValue", "min", and "max" to be numbers, with min ≤ max.';
        }
        break;

      case "numeric_input":
        if (
          setting.defaultValue !== undefined &&
          typeof setting.defaultValue !== "number"
        ) {
          isValidSetting = false;
          skipReason =
            'Numeric input type requires "defaultValue" to be a number if provided.';
        }
        if (setting.min !== undefined && typeof setting.min !== "number") {
          isValidSetting = false;
          skipReason =
            'Numeric input type requires "min" to be a number if provided.';
        }
        if (setting.max !== undefined && typeof setting.max !== "number") {
          isValidSetting = false;
          skipReason =
            'Numeric input type requires "max" to be a number if provided.';
        }
        if (setting.step !== undefined && typeof setting.step !== "number") {
          isValidSetting = false;
          skipReason =
            'Numeric input type requires "step" to be a number if provided.';
        }
        if (
          setting.placeholder !== undefined &&
          typeof setting.placeholder !== "string"
        ) {
          isValidSetting = false;
          skipReason =
            'Numeric input type requires "placeholder" to be a string if provided.';
        }
        break;

      case "time_picker":
        if (
          setting.defaultValue !== undefined &&
          typeof setting.defaultValue !== "number"
        ) {
          isValidSetting = false;
          skipReason =
            'Time picker type requires "defaultValue" to be a number (total seconds) if provided.';
        }
        if (
          setting.showSeconds !== undefined &&
          typeof setting.showSeconds !== "boolean"
        ) {
          isValidSetting = false;
          skipReason =
            'Time picker type requires "showSeconds" to be a boolean if provided.';
        }
        break;

      default:
        // Unknown setting type - skip it but don't fail the entire config
        isValidSetting = false;
        skipReason = `Unknown setting type "${setting.type}". Supported types: toggle, text, text_no_save_button, select, select_with_search, multiselect, slider, numeric_input, time_picker, group, titleValue.`;
        break;
    }

    if (isValidSetting) {
      validSettings.push(setting);
    } else {
      skippedSettings.push({
        index: index + 1,
        type: setting.type,
        reason: skipReason,
      });
    }
  }

  // Include valid settings in cleaned config
  cleanedConfig.settings = validSettings;

  // Include tools as-is (no validation needed for tools currently)
  if (config.tools) {
    cleanedConfig.tools = config.tools;
  }

  return {
    isValid: true,
    cleanedConfig,
    skippedSettings: skippedSettings.length > 0 ? skippedSettings : undefined,
  };
}

/**
 * Normalizes a URL by ensuring it has https:// and removing trailing slashes
 * Based on the normalizeUrl function from the frontend
 * @param url - URL to normalize
 * @returns Normalized URL
 */
function normalizeUrl(url: string): string {
  if (!url || url.trim() === "") {
    return "";
  }

  let normalized = url.trim();

  // Add https:// if no protocol specified
  if (!normalized.match(/^https?:\/\//)) {
    normalized = `https://${normalized}`;
  }

  // Remove trailing slash
  normalized = normalized.replace(/\/+$/, "");

  return normalized;
}

/**
 * Fetches a URL and returns the response body as a string
 * @param url - URL to fetch
 * @param timeoutMs - Timeout in milliseconds
 * @returns Promise resolving to response body string
 */
function fetchUrl(url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === "https:";
    const httpModule = isHttps ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: "GET",
      timeout: timeoutMs,
      headers: {
        "User-Agent": "AugmentOS-Migration-Script/1.0",
        Accept: "application/json, text/plain, */*",
      },
      // Skip SSL certificate verification if requested
      ...(SKIP_SSL && isHttps ? { rejectUnauthorized: false } : {}),
    };

    const req = httpModule.request(options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
        }
      });
    });

    req.on("error", (error) => {
      reject(error);
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });

    req.end();
  });
}

/**
 * Attempts to fetch and parse app_config.json from an app's server
 * @param app - App document from database
 * @returns Promise resolving to parsed config and skipped settings info, or null if not found/invalid
 */
async function fetchAppConfig(app: AppI): Promise<{
  config: AppConfigFile;
  skippedSettingsCount: number;
} | null> {
  if (!app.publicUrl || app.publicUrl.trim() === "") {
    logger.debug(`App ${app.packageName} has no publicUrl, skipping`);
    return null;
  }

  try {
    const normalizedUrl = normalizeUrl(app.publicUrl);
    const configUrl = `${normalizedUrl}/app_config.json`;

    logger.debug(`Fetching config from: ${configUrl}`);

    const response = await fetchUrl(configUrl, TIMEOUT_SECONDS * 1000);

    if (!response || response.trim() === "") {
      logger.debug(`Empty response from ${configUrl}`);
      return null;
    }

    let config;
    try {
      config = JSON.parse(response);
    } catch (parseError) {
      logger.warn(`JSON parse error for ${app.packageName}: ${parseError}`);
      return null;
    }

    // Validate configuration structure
    const validation = validateAppConfig(config);
    if (!validation.isValid) {
      logger.warn(
        `Invalid config structure for ${app.packageName}: ${validation.error}`,
      );
      return null;
    }

    // Log information about skipped settings if any
    const skippedCount = validation.skippedSettings?.length || 0;
    if (validation.skippedSettings && validation.skippedSettings.length > 0) {
      logger.warn(
        `Config for ${app.packageName} has ${validation.skippedSettings.length} invalid/unsupported settings that will be skipped:`,
      );
      validation.skippedSettings.forEach((skipped) => {
        logger.warn(
          `  - Setting ${skipped.index} (type: ${skipped.type}): ${skipped.reason}`,
        );
      });
    }

    logger.info(
      `Successfully fetched and validated config for ${app.packageName}`,
    );
    return {
      config: validation.cleanedConfig as AppConfigFile,
      skippedSettingsCount: skippedCount,
    };
  } catch (error) {
    if (error instanceof Error) {
      // Log at debug level for common errors to avoid noise
      if (
        error.message.includes("ENOTFOUND") ||
        error.message.includes("ECONNREFUSED") ||
        error.message.includes("timeout") ||
        error.message.includes("HTTP 404")
      ) {
        logger.debug(
          `Config not available for ${app.packageName}: ${error.message}`,
        );
      } else {
        logger.warn(
          `Error fetching config for ${app.packageName}: ${error.message}`,
        );
      }
    } else {
      logger.warn(
        `Unknown error fetching config for ${app.packageName}: ${error}`,
      );
    }
    return null;
  }
}

/**
 * Recursively removes _id fields and empty options/enum arrays from objects and arrays
 * Based on removeIdFields function from EditApp.tsx
 * @param obj - The object or array to clean
 * @returns The cleaned object without _id fields and empty options/enum arrays
 */
function removeIdFields(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(removeIdFields);
  } else if (obj !== null && typeof obj === "object") {
    const cleaned: any = {};
    for (const [key, value] of Object.entries(obj)) {
      // Skip any field that is exactly "_id"
      if (key !== "_id") {
        // Skip empty options or enum arrays
        if (
          (key === "options" || key === "enum") &&
          Array.isArray(value) &&
          value.length === 0
        ) {
          continue;
        }
        cleaned[key] = removeIdFields(value);
      }
    }
    return cleaned;
  }
  return obj;
}

/**
 * Updates an app in the database with imported configuration
 * @param app - App document to update
 * @param config - Configuration data to import
 * @returns Promise resolving to update result summary
 */
async function updateAppWithConfig(
  app: AppI,
  config: AppConfigFile,
): Promise<{
  fieldsUpdated: string[];
  fieldsSkipped: string[];
  settingsCount: number;
  toolsCount: number;
}> {
  const fieldsUpdated: string[] = [];
  const fieldsSkipped: string[] = [];
  const updateData: any = {};

  // Check if settings should be updated (only if empty/null/undefined)
  const hasExistingSettings =
    app.settings && Array.isArray(app.settings) && app.settings.length > 0;
  if (!hasExistingSettings && config.settings) {
    updateData.settings = removeIdFields(config.settings);
    fieldsUpdated.push("settings");
  } else if (hasExistingSettings) {
    fieldsSkipped.push("settings (already has data)");
  }

  // Check if tools should be updated (only if empty/null/undefined)
  const hasExistingTools =
    app.tools && Array.isArray(app.tools) && app.tools.length > 0;
  if (!hasExistingTools && config.tools) {
    updateData.tools = removeIdFields(config.tools);
    fieldsUpdated.push("tools");
  } else if (hasExistingTools) {
    fieldsSkipped.push("tools (already has data)");
  }

  // Only perform update if there's something to update
  if (Object.keys(updateData).length > 0 && !DRY_RUN) {
    await App.findByIdAndUpdate(app._id, { $set: updateData });
  }

  return {
    fieldsUpdated,
    fieldsSkipped,
    settingsCount: (config.settings || []).length,
    toolsCount: (config.tools || []).length,
  };
}

/**
 * Main migration function
 */
async function migrate() {
  try {
    // Connect to MongoDB
    const dbUri =
      process.env.MONGO_URL || "mongodb://localhost:27017/augmentos";
    logger.info(`Connecting to MongoDB: ${dbUri}`);

    await mongoose.connect(dbUri);
    logger.info("Connected to MongoDB");

    // Initialize counters
    let totalApps = 0;
    let appsProcessed = 0;
    let configsFound = 0;
    let configsImported = 0;
    let errorCount = 0;
    let settingsUpdated = 0;
    let settingsSkipped = 0;
    let toolsUpdated = 0;
    let toolsSkipped = 0;
    let totalSkippedSettings = 0;
    const errors: any[] = [];

    // Construct query filter based on package name pattern if provided
    const query: any = {};
    if (PACKAGE_FILTER) {
      query.packageName = { $regex: PACKAGE_FILTER };
    }

    // Get total count for progress tracking
    totalApps = await App.countDocuments(query);
    logger.info(`Found ${totalApps} apps to process`);

    if (totalApps === 0) {
      logger.info("No apps found matching criteria");
      return;
    }

    // Process each app
    logger.info("Starting app configuration import...");
    const appCursor = App.find(query).cursor();

    for await (const app of appCursor) {
      appsProcessed++;
      logger.info(
        `Processing app ${appsProcessed}/${totalApps}: ${app.packageName}`,
      );

      try {
        // Attempt to fetch app_config.json
        const configResult = await fetchAppConfig(app);

        if (!configResult) {
          logger.debug(`No valid config found for ${app.packageName}`);
          continue;
        }

        configsFound++;

        // Track skipped settings
        totalSkippedSettings += configResult.skippedSettingsCount;

        // Update app with imported configuration
        const updateResult = await updateAppWithConfig(
          app,
          configResult.config,
        );

        // Track what was actually updated
        if (updateResult.fieldsUpdated.length > 0) {
          configsImported++;
          if (updateResult.fieldsUpdated.includes("settings")) {
            settingsUpdated++;
          }
          if (updateResult.fieldsUpdated.includes("tools")) {
            toolsUpdated++;
          }
        }

        // Track what was skipped
        if (
          updateResult.fieldsSkipped.some((field) => field.includes("settings"))
        ) {
          settingsSkipped++;
        }
        if (
          updateResult.fieldsSkipped.some((field) => field.includes("tools"))
        ) {
          toolsSkipped++;
        }

        logger.info(`Successfully processed config for ${app.packageName}:`);
        if (updateResult.fieldsUpdated.length > 0) {
          logger.info(
            `  - Fields updated: ${updateResult.fieldsUpdated.join(", ")}`,
          );
        }
        if (updateResult.fieldsSkipped.length > 0) {
          logger.info(
            `  - Fields skipped: ${updateResult.fieldsSkipped.join(", ")}`,
          );
        }
        logger.info(`  - Settings: ${updateResult.settingsCount}`);
        logger.info(`  - Tools: ${updateResult.toolsCount}`);
      } catch (error: any) {
        errorCount++;
        logger.error(`Error processing app ${app.packageName}:`, error);
        errors.push({
          packageName: app.packageName,
          error: error.message || error.toString(),
        });
      }
    }

    // Log summary
    logger.info("=== Migration Summary ===");
    logger.info(`Total apps: ${totalApps}`);
    logger.info(`Apps processed: ${appsProcessed}`);
    logger.info(`Configs found: ${configsFound}`);
    logger.info(`Configs imported: ${configsImported}`);
    logger.info(`Settings updated: ${settingsUpdated}`);
    logger.info(`Settings skipped (already had data): ${settingsSkipped}`);
    logger.info(`Tools updated: ${toolsUpdated}`);
    logger.info(`Tools skipped (already had data): ${toolsSkipped}`);
    if (totalSkippedSettings > 0) {
      logger.info(
        `Invalid/unsupported settings skipped during import: ${totalSkippedSettings}`,
      );
    }
    logger.info(`Errors: ${errorCount}`);

    if (DRY_RUN) {
      logger.info("DRY RUN: No changes were made to the database");
    }

    // Log errors if any
    if (errors.length > 0) {
      logger.warn("=== Errors Encountered ===");
      errors.forEach((err, index) => {
        logger.warn(`${index + 1}. ${err.packageName}: ${err.error}`);
      });
    }

    logger.info("Migration completed successfully");
  } catch (error) {
    logger.error("Migration failed:", error);
    throw error;
  } finally {
    // Close database connection
    await mongoose.disconnect();
    logger.info("Database connection closed");
  }
}

// Run migration if this file is executed directly
if (require.main === module) {
  migrate().catch((error) => {
    logger.error("Migration script failed:", error);
    process.exit(1);
  });
}

export default migrate;
