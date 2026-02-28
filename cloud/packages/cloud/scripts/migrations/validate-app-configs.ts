/**
 * Validation script: Verify App Configuration Import
 *
 * This script validates that the App configuration migration was successful by:
 * 1. Checking each app for the presence of settings, tools, and permissions
 * 2. Validating the structure of imported configurations
 * 3. Reporting statistics on the migration success
 * 4. Identifying apps that may need manual attention
 *
 * Usage:
 * ts-node -r tsconfig-paths/register scripts/migrations/validate-app-configs.ts
 *
 * Options:
 * --package-filter  Only validate apps with package name matching pattern (supports regex)
 * --detailed        Show detailed information for each app
 * --only-issues     Only show apps with potential issues
 */

import mongoose from "mongoose";
import dotenv from "dotenv";
import App, { AppI } from "../../src/models/app.model";
import { logger as rootLogger } from "../../src/services/logging/pino-logger";

// Configure environment
dotenv.config();

const logger = rootLogger.child({ script: "validate-app-configs" });
const DETAILED_OUTPUT = process.argv.includes("--detailed");
const ONLY_ISSUES = process.argv.includes("--only-issues");

// Parse command line arguments
const PACKAGE_FILTER_ARG = process.argv.find((arg) =>
  arg.startsWith("--package-filter="),
);
const PACKAGE_FILTER = PACKAGE_FILTER_ARG
  ? PACKAGE_FILTER_ARG.split("=")[1]
  : null;

if (PACKAGE_FILTER) {
  logger.info(
    `Package filter mode: Only validating apps with package name matching: ${PACKAGE_FILTER}`,
  );
}

if (DETAILED_OUTPUT) {
  logger.info("Detailed output mode enabled");
}

if (ONLY_ISSUES) {
  logger.info("Only issues mode: Only showing apps with potential problems");
}

/**
 * Validation result for a single app
 */
interface AppValidationResult {
  packageName: string;
  hasName: boolean;
  hasDescription: boolean;
  hasSettings: boolean;
  hasTools: boolean;
  hasPermissions: boolean;
  settingsCount: number;
  toolsCount: number;
  permissionsCount: number;
  hasPublicUrl: boolean;
  hasLogoUrl: boolean;
  hasWebviewUrl: boolean;
  hasVersion: boolean;
  issues: string[];
  score: number; // 0-100 completeness score
}

/**
 * Overall validation statistics
 */
interface ValidationStats {
  totalApps: number;
  appsWithSettings: number;
  appsWithTools: number;
  appsWithPermissions: number;
  appsWithName: number;
  appsWithDescription: number;
  appsWithPublicUrl: number;
  appsWithIssues: number;
  averageScore: number;
  settingsTotal: number;
  toolsTotal: number;
  permissionsTotal: number;
}

/**
 * Validates a single app's configuration
 * @param app - App document to validate
 * @returns Validation result for the app
 */
function validateApp(app: AppI): AppValidationResult {
  const issues: string[] = [];
  let score = 0;

  // Check basic required fields
  const hasName = !!(app.name && app.name.trim() !== "");
  const hasDescription = !!(app.description && app.description.trim() !== "");
  const hasPublicUrl = !!(app.publicUrl && app.publicUrl.trim() !== "");

  if (hasName) score += 20;
  else issues.push("Missing app name");

  if (hasDescription) score += 20;
  else issues.push("Missing app description");

  if (hasPublicUrl) score += 10;
  else issues.push("Missing publicUrl");

  // Check optional URL fields
  const hasLogoUrl = !!(app.logoURL && app.logoURL.trim() !== "");
  const hasWebviewUrl = !!(app.webviewURL && app.webviewURL.trim() !== "");
  const hasVersion = !!(app.version && app.version.trim() !== "");

  if (hasLogoUrl) score += 5;
  if (hasWebviewUrl) score += 5;
  if (hasVersion) score += 5;

  // Check configuration arrays
  const hasSettings = !!(app.settings && app.settings.length > 0);
  const hasTools = !!(app.tools && app.tools.length > 0);
  const hasPermissions = !!(app.permissions && app.permissions.length > 0);

  const settingsCount = app.settings?.length || 0;
  const toolsCount = app.tools?.length || 0;
  const permissionsCount = app.permissions?.length || 0;

  if (hasSettings) score += 15;
  if (hasTools) score += 10;
  if (hasPermissions) score += 10;

  // Validate settings structure
  if (app.settings) {
    for (let i = 0; i < app.settings.length; i++) {
      const setting = app.settings[i];

      // Group settings just need a title
      if (setting.type === "group") {
        if (!setting.title || setting.title.trim() === "") {
          issues.push(`Setting ${i + 1}: Group missing title`);
        }
        continue;
      }

      // TITLE_VALUE settings just need label and value
      if (setting.type === "titleValue") {
        if (!setting.label || setting.label.trim() === "") {
          issues.push(`Setting ${i + 1}: TitleValue missing label`);
        }
        if (setting.value === undefined || setting.value === null) {
          issues.push(`Setting ${i + 1}: TitleValue missing value`);
        }
        continue;
      }

      // Regular settings need key, label, and type
      if (!setting.key || setting.key.trim() === "") {
        issues.push(`Setting ${i + 1}: Missing key`);
      }
      if (!setting.label || setting.label.trim() === "") {
        issues.push(`Setting ${i + 1}: Missing label`);
      }
      if (!setting.type || setting.type.trim() === "") {
        issues.push(`Setting ${i + 1}: Missing type`);
      }

      // Type-specific validation
      if (
        setting.type === "select" &&
        (!setting.options || setting.options.length === 0)
      ) {
        issues.push(`Setting ${i + 1}: Select type missing options`);
      }

      if (
        setting.type === "select_with_search" &&
        (!setting.options || setting.options.length === 0)
      ) {
        issues.push(`Setting ${i + 1}: SelectWithSearch type missing options`);
      }

      if (
        setting.type === "multiselect" &&
        (!setting.options || setting.options.length === 0)
      ) {
        issues.push(`Setting ${i + 1}: Multiselect type missing options`);
      }

      if (setting.type === "slider") {
        if (
          typeof setting.min !== "number" ||
          typeof setting.max !== "number"
        ) {
          issues.push(`Setting ${i + 1}: Slider missing min/max values`);
        }
      }

      if (setting.type === "numeric_input") {
        if (setting.min !== undefined && typeof setting.min !== "number") {
          issues.push(
            `Setting ${i + 1}: Numeric input min value must be a number`,
          );
        }
        if (setting.max !== undefined && typeof setting.max !== "number") {
          issues.push(
            `Setting ${i + 1}: Numeric input max value must be a number`,
          );
        }
        if (setting.step !== undefined && typeof setting.step !== "number") {
          issues.push(
            `Setting ${i + 1}: Numeric input step value must be a number`,
          );
        }
        if (
          setting.placeholder !== undefined &&
          typeof setting.placeholder !== "string"
        ) {
          issues.push(
            `Setting ${i + 1}: Numeric input placeholder must be a string`,
          );
        }
        if (
          setting.defaultValue !== undefined &&
          typeof setting.defaultValue !== "number"
        ) {
          issues.push(
            `Setting ${i + 1}: Numeric input defaultValue must be a number`,
          );
        }
      }

      if (setting.type === "time_picker") {
        if (
          setting.showSeconds !== undefined &&
          typeof setting.showSeconds !== "boolean"
        ) {
          issues.push(
            `Setting ${i + 1}: Time picker showSeconds must be a boolean`,
          );
        }
        if (
          setting.defaultValue !== undefined &&
          typeof setting.defaultValue !== "number"
        ) {
          issues.push(
            `Setting ${i + 1}: Time picker defaultValue must be a number (total seconds)`,
          );
        }
      }
    }
  }

  // Validate tools structure
  if (app.tools) {
    for (let i = 0; i < app.tools.length; i++) {
      const tool = app.tools[i];

      if (!tool.id || tool.id.trim() === "") {
        issues.push(`Tool ${i + 1}: Missing id`);
      }
      if (!tool.description || tool.description.trim() === "") {
        issues.push(`Tool ${i + 1}: Missing description`);
      }
    }
  }

  // Validate permissions structure
  if (app.permissions) {
    for (let i = 0; i < app.permissions.length; i++) {
      const permission = app.permissions[i];

      if (!permission.type || permission.type.trim() === "") {
        issues.push(`Permission ${i + 1}: Missing type`);
      }
    }
  }

  // Check for completely empty configuration
  if (!hasSettings && !hasTools && !hasPermissions) {
    issues.push("No configuration data (settings, tools, or permissions)");
  }

  return {
    packageName: app.packageName,
    hasName,
    hasDescription,
    hasSettings,
    hasTools,
    hasPermissions,
    settingsCount,
    toolsCount,
    permissionsCount,
    hasPublicUrl,
    hasLogoUrl,
    hasWebviewUrl,
    hasVersion,
    issues,
    score,
  };
}

/**
 * Formats a validation result for display
 * @param result - App validation result
 * @returns Formatted string
 */
function formatAppResult(result: AppValidationResult): string {
  const lines: string[] = [];

  lines.push(`📱 ${result.packageName} (Score: ${result.score}/100)`);

  if (DETAILED_OUTPUT || result.issues.length > 0) {
    lines.push(
      `   ✓ Basic info: ${result.hasName ? "✓" : "✗"} name, ${result.hasDescription ? "✓" : "✗"} description`,
    );
    lines.push(
      `   ✓ URLs: ${result.hasPublicUrl ? "✓" : "✗"} public, ${result.hasLogoUrl ? "✓" : "✗"} logo, ${result.hasWebviewUrl ? "✓" : "✗"} webview`,
    );
    lines.push(
      `   ✓ Config: ${result.settingsCount} settings, ${result.toolsCount} tools, ${result.permissionsCount} permissions`,
    );

    if (result.issues.length > 0) {
      lines.push(`   ⚠️  Issues:`);
      result.issues.forEach((issue) => {
        lines.push(`      - ${issue}`);
      });
    }
  }

  return lines.join("\n");
}

/**
 * Main validation function
 */
async function validate() {
  try {
    // Connect to MongoDB
    const dbUri =
      process.env.MONGO_URL || "mongodb://localhost:27017/augmentos";
    logger.info(`Connecting to MongoDB: ${dbUri}`);

    await mongoose.connect(dbUri);
    logger.info("Connected to MongoDB");

    // Construct query filter based on package name pattern if provided
    const query: any = {};
    if (PACKAGE_FILTER) {
      query.packageName = { $regex: PACKAGE_FILTER };
    }

    // Initialize statistics
    const stats: ValidationStats = {
      totalApps: 0,
      appsWithSettings: 0,
      appsWithTools: 0,
      appsWithPermissions: 0,
      appsWithName: 0,
      appsWithDescription: 0,
      appsWithPublicUrl: 0,
      appsWithIssues: 0,
      averageScore: 0,
      settingsTotal: 0,
      toolsTotal: 0,
      permissionsTotal: 0,
    };

    const appResults: AppValidationResult[] = [];

    // Process each app
    logger.info("Starting validation...");
    const appCursor = App.find(query).cursor();

    for await (const app of appCursor) {
      const result = validateApp(app);
      appResults.push(result);

      // Update statistics
      stats.totalApps++;
      if (result.hasSettings) stats.appsWithSettings++;
      if (result.hasTools) stats.appsWithTools++;
      if (result.hasPermissions) stats.appsWithPermissions++;
      if (result.hasName) stats.appsWithName++;
      if (result.hasDescription) stats.appsWithDescription++;
      if (result.hasPublicUrl) stats.appsWithPublicUrl++;
      if (result.issues.length > 0) stats.appsWithIssues++;

      stats.settingsTotal += result.settingsCount;
      stats.toolsTotal += result.toolsCount;
      stats.permissionsTotal += result.permissionsCount;
    }

    // Calculate average score
    if (stats.totalApps > 0) {
      stats.averageScore = Math.round(
        appResults.reduce((sum, result) => sum + result.score, 0) /
          stats.totalApps,
      );
    }

    // Sort results by score (lowest first to highlight issues)
    appResults.sort((a, b) => a.score - b.score);

    // Display results
    logger.info("\n=== App Configuration Validation Results ===\n");

    // Show individual app results
    appResults.forEach((result) => {
      // Skip apps without issues if only-issues mode is enabled
      if (ONLY_ISSUES && result.issues.length === 0) {
        return;
      }

      console.log(formatAppResult(result));
      console.log(""); // Empty line for spacing
    });

    // Display summary statistics
    console.log("=== Summary Statistics ===");
    console.log(`📊 Total apps analyzed: ${stats.totalApps}`);
    console.log(`📊 Average completeness score: ${stats.averageScore}/100`);
    console.log("");
    console.log("📋 Apps with configuration:");
    console.log(
      `   • Settings: ${stats.appsWithSettings}/${stats.totalApps} (${Math.round((stats.appsWithSettings / stats.totalApps) * 100)}%)`,
    );
    console.log(
      `   • Tools: ${stats.appsWithTools}/${stats.totalApps} (${Math.round((stats.appsWithTools / stats.totalApps) * 100)}%)`,
    );
    console.log(
      `   • Permissions: ${stats.appsWithPermissions}/${stats.totalApps} (${Math.round((stats.appsWithPermissions / stats.totalApps) * 100)}%)`,
    );
    console.log("");
    console.log("📝 Apps with basic info:");
    console.log(
      `   • Name: ${stats.appsWithName}/${stats.totalApps} (${Math.round((stats.appsWithName / stats.totalApps) * 100)}%)`,
    );
    console.log(
      `   • Description: ${stats.appsWithDescription}/${stats.totalApps} (${Math.round((stats.appsWithDescription / stats.totalApps) * 100)}%)`,
    );
    console.log(
      `   • Public URL: ${stats.appsWithPublicUrl}/${stats.totalApps} (${Math.round((stats.appsWithPublicUrl / stats.totalApps) * 100)}%)`,
    );
    console.log("");
    console.log("🔢 Configuration totals:");
    console.log(`   • Total settings: ${stats.settingsTotal}`);
    console.log(`   • Total tools: ${stats.toolsTotal}`);
    console.log(`   • Total permissions: ${stats.permissionsTotal}`);
    console.log("");
    console.log(
      `⚠️  Apps with issues: ${stats.appsWithIssues}/${stats.totalApps} (${Math.round((stats.appsWithIssues / stats.totalApps) * 100)}%)`,
    );

    // Show recommendations
    console.log("\n=== Recommendations ===");

    if (stats.appsWithIssues > 0) {
      console.log("🔧 Review apps with validation issues above");
    }

    if (stats.appsWithSettings < stats.totalApps * 0.5) {
      console.log(
        "📄 Consider running migration with --force to import configs for apps without settings",
      );
    }

    if (stats.appsWithName < stats.totalApps) {
      console.log(
        "📝 Some apps are missing names - these may need manual updates",
      );
    }

    if (stats.appsWithPublicUrl < stats.totalApps) {
      console.log(
        "🌐 Some apps are missing public URLs - migration may not have been able to fetch their configs",
      );
    }

    logger.info("\nValidation completed successfully");
  } catch (error) {
    logger.error("Validation failed:", error);
    throw error;
  } finally {
    // Close database connection
    await mongoose.disconnect();
    logger.info("Database connection closed");
  }
}

// Run validation if this file is executed directly
if (require.main === module) {
  validate().catch((error) => {
    logger.error("Validation script failed:", error);
    process.exit(1);
  });
}

export default validate;
