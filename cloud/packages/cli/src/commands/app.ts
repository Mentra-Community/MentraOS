/**
 * App Management Commands
 *
 * Commands: app list, app get, app create, app update, app delete, app publish, app api-key, app export, app import
 */

import chalk from "chalk";
import { Command } from "commander";

import { api } from "../api/client";
import { requireAuth } from "../config/credentials";
import { displayTable, displayJSON, success, error } from "../utils/output";
import { input, select, confirm } from "../utils/prompt";

// Valid permission types
const VALID_PERMISSIONS = [
  "MICROPHONE",
  "LOCATION",
  "BACKGROUND_LOCATION",
  "CALENDAR",
  "CAMERA",
  "NOTIFICATIONS",
  "READ_NOTIFICATIONS",
  "POST_NOTIFICATIONS",
  "ALL",
] as const;

type PermissionType = (typeof VALID_PERMISSIONS)[number];

function isValidPermission(perm: string): perm is PermissionType {
  return VALID_PERMISSIONS.includes(perm.toUpperCase() as PermissionType);
}

function parsePermissions(permString: string): Array<{ type: string; description?: string }> {
  return permString
    .split(",")
    .map((p) => p.trim().toUpperCase())
    .filter((p) => p.length > 0)
    .map((type) => ({ type }));
}

export const appCommand = new Command("app").description("Manage apps");

// List apps
appCommand
  .command("list")
  .alias("ls")
  .description("List apps")
  .option("--org <id>", "Organization ID")
  .option("--json", "Output JSON")
  .action(async (options) => {
    try {
      await requireAuth();
      const apps = await api.listApps(options.org);

      if (options.json || options.parent?.opts().json) {
        displayJSON(apps);
      } else {
        if (apps.length === 0) {
          console.log("No apps found");
          return;
        }

        displayTable(apps, ["packageName", "name", "appType", "appStoreStatus"]);
        console.log(`\n${chalk.cyan(apps.length)} apps total`);
      }
    } catch (err: any) {
      error(`Failed to list apps: ${err.message}`);
      process.exit(1);
    }
  });

// Get app
appCommand
  .command("get")
  .argument("<package-name>", "Package name")
  .description("Get app details")
  .action(async (packageName: string) => {
    try {
      await requireAuth();
      const app = await api.getApp(packageName);
      displayJSON(app);
    } catch (err: any) {
      error(`App not found: ${err.message}`);
      process.exit(5);
    }
  });

// Create app
appCommand
  .command("create")
  .description("Create new app")
  .option("--package-name <name>", "Package name (e.g., com.example.myapp)")
  .option("--name <name>", "App name")
  .option("--description <text>", "App description")
  .option("--app-type <type>", "App type (background or standard)")
  .option("--public-url <url>", "Public URL")
  .option("--logo-url <url>", "Logo URL")
  .option("--org <id>", "Organization ID")
  .action(async (options) => {
    try {
      await requireAuth();

      // Determine if we're in interactive mode (no flags provided)
      const isInteractive = !options.packageName;

      // Get values from flags or prompts
      const packageName =
        options.packageName || (await input("Package name (e.g., com.example.myapp):", { required: true }));

      // Validate package name format
      if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(packageName)) {
        error("Invalid package name format. Use reverse domain notation (e.g., com.example.myapp)");
        process.exit(7);
      }

      const name = options.name || (await input("App name:", { required: true }));

      const description =
        options.description || (isInteractive ? await input("Description:", { required: false }) : "");

      const appType = options.appType || (await select("App type:", ["background", "standard"]));

      const publicUrl = options.publicUrl || (await input("Public URL:", { required: true }));

      // Validate URL format
      try {
        new URL(publicUrl);
      } catch {
        error("Invalid URL format");
        process.exit(7);
      }

      const logoUrl =
        options.logoUrl || (isInteractive ? await input("Logo URL (optional):", { required: false }) : "");

      // Confirm before creating
      if (isInteractive) {
        // Only ask for confirmation in interactive mode
        console.log("\nApp configuration:");
        console.log(`  Package: ${chalk.cyan(packageName)}`);
        console.log(`  Name: ${chalk.cyan(name)}`);
        console.log(`  Type: ${chalk.cyan(appType)}`);
        console.log(`  URL: ${chalk.cyan(publicUrl)}`);
        if (description) console.log(`  Description: ${chalk.cyan(description)}`);
        if (logoUrl) console.log(`  Logo: ${chalk.cyan(logoUrl)}`);
        console.log();

        const confirmed = await confirm("Create this app?", true);
        if (!confirmed) {
          console.log("Cancelled");
          process.exit(0);
        }
      }

      // Create the app
      const appData: any = {
        packageName,
        name,
        appType,
        publicUrl,
      };

      if (description) appData.description = description;
      if (logoUrl) appData.logoURL = logoUrl;

      console.log("\nCreating app...");
      const result = await api.createApp(appData);

      success(`App created: ${result.app.packageName}`);

      // Display the API key (only shown once!)
      if (result.apiKey) {
        console.log();
        console.log(chalk.yellow("⚠️  IMPORTANT: Save this API key - it won't be shown again!"));
        console.log();
        console.log(chalk.cyan("  API Key: ") + chalk.bold.white(result.apiKey));
        console.log();
      }

      // Display app details
      console.log("\nApp details:");
      displayJSON(result.app);
    } catch (err: any) {
      error(`Failed to create app: ${err.message}`);
      process.exit(1);
    }
  });

appCommand
  .command("update")
  .argument("<package-name>", "Package name")
  .description("Update app")
  .option("--name <name>", "App name")
  .option("--description <text>", "App description")
  .option("--public-url <url>", "Public URL")
  .option("--webview-url <url>", "Webview URL")
  .option("--logo-url <url>", "Logo URL")
  .option("--add-permission <type>", "Add a permission (e.g., MICROPHONE, LOCATION, CAMERA, CALENDAR)")
  .option("--remove-permission <type>", "Remove a permission")
  .option("--permissions <types>", "Set all permissions (comma-separated, e.g., MICROPHONE,LOCATION)")
  .action(async (packageName: string, options) => {
    try {
      await requireAuth();

      // Determine if we're in interactive mode (no flags provided)
      const isInteractive =
        !options.name &&
        !options.description &&
        !options.publicUrl &&
        !options.webviewUrl &&
        !options.logoUrl &&
        !options.addPermission &&
        !options.removePermission &&
        !options.permissions;

      if (isInteractive) {
        // Fetch current app details
        console.log("Fetching current app details...");
        const currentApp = await api.getApp(packageName);

        const currentPermissions = currentApp.permissions?.map((p: any) => p.type).join(", ") || "(none)";

        console.log("\nCurrent values:");
        console.log(`  Name: ${chalk.cyan(currentApp.name)}`);
        console.log(`  Description: ${chalk.cyan(currentApp.description || "(none)")}`);
        console.log(`  Public URL: ${chalk.cyan(currentApp.publicUrl)}`);
        console.log(`  Webview URL: ${chalk.cyan(currentApp.webviewURL || "(none)")}`);
        console.log(`  Logo URL: ${chalk.cyan(currentApp.logoURL || "(none)")}`);
        console.log(`  Permissions: ${chalk.cyan(currentPermissions)}`);
        console.log();

        // Prompt for updates (allow empty to keep current value)
        const name = await input(`App name (${currentApp.name}):`, { required: false });
        const description = await input(`Description (${currentApp.description || "none"}):`, { required: false });
        const publicUrl = await input(`Public URL (${currentApp.publicUrl}):`, { required: false });
        const webviewUrl = await input(`Webview URL (${currentApp.webviewURL || "none"}):`, { required: false });
        const logoUrl = await input(`Logo URL (${currentApp.logoURL || "none"}):`, { required: false });

        // Build update data (only include changed fields)
        const updateData: any = {};
        if (name) updateData.name = name;
        if (description) updateData.description = description;
        if (publicUrl) {
          try {
            new URL(publicUrl);
            updateData.publicUrl = publicUrl;
          } catch {
            error("Invalid URL format");
            process.exit(7);
          }
        }
        if (webviewUrl) {
          try {
            new URL(webviewUrl);
            updateData.webviewURL = webviewUrl;
          } catch {
            error("Invalid webview URL format");
            process.exit(7);
          }
        }
        if (logoUrl) updateData.logoURL = logoUrl;

        if (Object.keys(updateData).length === 0) {
          console.log("No changes made");
          process.exit(0);
        }

        // Confirm before updating
        const confirmed = await confirm("Update this app?", true);
        if (!confirmed) {
          console.log("Cancelled");
          process.exit(0);
        }

        console.log("\nUpdating app...");
        const result = await api.updateApp(packageName, updateData);
        success(`App updated: ${result.packageName}`);
        console.log("\nUpdated app details:");
        displayJSON(result);
      } else {
        // Non-interactive mode: use flags
        const updateData: any = {};
        if (options.name) updateData.name = options.name;
        if (options.description) updateData.description = options.description;
        if (options.publicUrl) {
          try {
            new URL(options.publicUrl);
            updateData.publicUrl = options.publicUrl;
          } catch {
            error("Invalid URL format");
            process.exit(7);
          }
        }
        if (options.webviewUrl) {
          try {
            new URL(options.webviewUrl);
            updateData.webviewURL = options.webviewUrl;
          } catch {
            error("Invalid webview URL format");
            process.exit(7);
          }
        }
        if (options.logoUrl) updateData.logoURL = options.logoUrl;

        // Handle permission updates
        if (options.permissions) {
          // Set all permissions (replaces existing)
          const perms = parsePermissions(options.permissions);
          for (const p of perms) {
            if (!isValidPermission(p.type)) {
              error(`Invalid permission type: ${p.type}`);
              console.log(`Valid permissions: ${VALID_PERMISSIONS.join(", ")}`);
              process.exit(7);
            }
          }
          updateData.permissions = perms;
          console.log(`Setting permissions: ${perms.map((p) => p.type).join(", ")}`);
        } else if (options.addPermission || options.removePermission) {
          // Add or remove specific permissions (need to fetch current app first)
          const currentApp = await api.getApp(packageName);
          let currentPerms: Array<{ type: string; description?: string }> = currentApp.permissions || [];

          if (options.addPermission) {
            const permType = options.addPermission.toUpperCase();
            if (!isValidPermission(permType)) {
              error(`Invalid permission type: ${permType}`);
              console.log(`Valid permissions: ${VALID_PERMISSIONS.join(", ")}`);
              process.exit(7);
            }
            // Check if already exists
            if (!currentPerms.some((p) => p.type === permType)) {
              currentPerms.push({ type: permType });
              console.log(`Adding permission: ${permType}`);
            } else {
              console.log(`Permission ${permType} already exists`);
            }
          }

          if (options.removePermission) {
            const permType = options.removePermission.toUpperCase();
            const beforeCount = currentPerms.length;
            currentPerms = currentPerms.filter((p) => p.type !== permType);
            if (currentPerms.length < beforeCount) {
              console.log(`Removing permission: ${permType}`);
            } else {
              console.log(`Permission ${permType} not found`);
            }
          }

          updateData.permissions = currentPerms;
        }

        console.log("Updating app...");
        const result = await api.updateApp(packageName, updateData);
        success(`App updated: ${result.packageName}`);
        displayJSON(result);
      }
    } catch (err: any) {
      error(`Failed to update app: ${err.message}`);
      process.exit(1);
    }
  });

appCommand
  .command("delete")
  .argument("<package-name>", "Package name")
  .description("Delete app")
  .option("--force", "Skip confirmation prompt")
  .action(async (packageName: string, options) => {
    try {
      await requireAuth();

      // Fetch app to verify it exists
      const app = await api.getApp(packageName);

      // Warn user about deletion
      console.log();
      console.log(chalk.red.bold("⚠️  WARNING: This action cannot be undone!"));
      console.log();
      console.log("You are about to delete:");
      console.log(`  Package: ${chalk.cyan(app.packageName)}`);
      console.log(`  Name: ${chalk.cyan(app.name)}`);
      console.log(`  Type: ${chalk.cyan(app.appType)}`);
      console.log();

      // Confirm deletion (unless --force)
      if (!options.force) {
        const confirmed = await confirm(`Type the package name to confirm deletion (${packageName}):`, false);
        if (!confirmed) {
          console.log("Cancelled");
          process.exit(0);
        }

        // Double confirmation for extra safety
        const doubleConfirm = await confirm("Are you absolutely sure?", false);
        if (!doubleConfirm) {
          console.log("Cancelled");
          process.exit(0);
        }
      }

      console.log("\nDeleting app...");
      await api.deleteApp(packageName);
      success(`App deleted: ${packageName}`);
    } catch (err: any) {
      error(`Failed to delete app: ${err.message}`);
      process.exit(1);
    }
  });

appCommand
  .command("publish")
  .argument("<package-name>", "Package name")
  .description("Publish app to store")
  .option("--force", "Skip confirmation prompt")
  .action(async (packageName: string, options) => {
    try {
      await requireAuth();

      // Fetch app to show details
      const app = await api.getApp(packageName);

      console.log("\nPublishing app to store:");
      console.log(`  Package: ${chalk.cyan(app.packageName)}`);
      console.log(`  Name: ${chalk.cyan(app.name)}`);
      console.log(`  Type: ${chalk.cyan(app.appType)}`);
      console.log(`  Current status: ${chalk.cyan(app.appStoreStatus || "unpublished")}`);
      console.log();

      // Confirm publication (unless --force)
      if (!options.force) {
        const confirmed = await confirm("Publish this app to the store?", true);
        if (!confirmed) {
          console.log("Cancelled");
          process.exit(0);
        }
      }

      console.log("\nPublishing...");
      const result = await api.publishApp(packageName);
      success(`App published: ${result.packageName}`);
      console.log(`\nNew status: ${chalk.green(result.appStoreStatus)}`);
    } catch (err: any) {
      error(`Failed to publish app: ${err.message}`);
      process.exit(1);
    }
  });

appCommand
  .command("api-key")
  .argument("<package-name>", "Package name")
  .description("Regenerate app API key")
  .option("--force", "Skip confirmation prompt")
  .action(async (packageName: string, options) => {
    try {
      await requireAuth();

      // Fetch app to verify it exists
      const app = await api.getApp(packageName);

      console.log();
      console.log(chalk.yellow.bold("⚠️  WARNING: This will invalidate the current API key!"));
      console.log();
      console.log("App details:");
      console.log(`  Package: ${chalk.cyan(app.packageName)}`);
      console.log(`  Name: ${chalk.cyan(app.name)}`);
      console.log();
      console.log("All existing integrations using the old key will stop working.");
      console.log();

      // Confirm regeneration (unless --force)
      if (!options.force) {
        const confirmed = await confirm("Regenerate API key for this app?", false);
        if (!confirmed) {
          console.log("Cancelled");
          process.exit(0);
        }
      }

      console.log("\nRegenerating API key...");
      const result = await api.regenerateApiKey(packageName);

      success(`API key regenerated for: ${packageName}`);

      // Display the new API key (only shown once!)
      if (result.apiKey) {
        console.log();
        console.log(chalk.yellow("⚠️  IMPORTANT: Save this API key - it won't be shown again!"));
        console.log();
        console.log(chalk.cyan("  New API Key: ") + chalk.bold.white(result.apiKey));
        console.log();
      }
    } catch (err: any) {
      error(`Failed to regenerate API key: ${err.message}`);
      process.exit(1);
    }
  });

appCommand
  .command("export")
  .argument("<package-name>", "Package name")
  .option("-o, --output <file>", "Output file")
  .description("Export app config to JSON")
  .action(async (packageName: string, options) => {
    try {
      await requireAuth();

      // Fetch app details
      const app = await api.getApp(packageName);

      // Prepare export data (remove sensitive/internal fields)
      const exportData = {
        packageName: app.packageName,
        name: app.name,
        description: app.description,
        appType: app.appType,
        publicUrl: app.publicUrl,
        logoURL: app.logoURL,
        // Add other exportable fields as needed
        exportedAt: new Date().toISOString(),
        exportedBy: "mentra-cli",
      };

      const jsonOutput = JSON.stringify(exportData, null, 2);

      // Determine output destination
      if (options.output) {
        // Write to file
        const fs = await import("fs/promises");
        await fs.writeFile(options.output, jsonOutput, "utf-8");
        success(`App config exported to: ${options.output}`);
      } else {
        // Output to stdout
        console.log(jsonOutput);
      }
    } catch (err: any) {
      error(`Failed to export app: ${err.message}`);
      process.exit(1);
    }
  });

appCommand
  .command("import")
  .argument("<file>", "JSON file")
  .option("--org <id>", "Organization ID")
  .option("--force", "Skip confirmation prompt")
  .description("Import app config from JSON")
  .action(async (file: string, options) => {
    try {
      await requireAuth();

      // Read and parse JSON file
      const fs = await import("fs/promises");
      const fileContent = await fs.readFile(file, "utf-8");
      const importData = JSON.parse(fileContent);

      // Validate required fields
      if (!importData.packageName) {
        error("Invalid import file: missing packageName");
        process.exit(7);
      }
      if (!importData.name) {
        error("Invalid import file: missing name");
        process.exit(7);
      }
      if (!importData.appType) {
        error("Invalid import file: missing appType");
        process.exit(7);
      }
      if (!importData.publicUrl) {
        error("Invalid import file: missing publicUrl");
        process.exit(7);
      }

      console.log("\nImporting app configuration:");
      console.log(`  Package: ${chalk.cyan(importData.packageName)}`);
      console.log(`  Name: ${chalk.cyan(importData.name)}`);
      console.log(`  Type: ${chalk.cyan(importData.appType)}`);
      console.log(`  URL: ${chalk.cyan(importData.publicUrl)}`);
      if (importData.description) {
        console.log(`  Description: ${chalk.cyan(importData.description)}`);
      }
      if (importData.logoURL) {
        console.log(`  Logo: ${chalk.cyan(importData.logoURL)}`);
      }
      console.log();

      // Confirm import (unless --force)
      if (!options.force) {
        const confirmed = await confirm("Import this app configuration?", true);
        if (!confirmed) {
          console.log("Cancelled");
          process.exit(0);
        }
      }

      // Prepare app data for creation
      const appData: any = {
        packageName: importData.packageName,
        name: importData.name,
        appType: importData.appType,
        publicUrl: importData.publicUrl,
      };

      if (importData.description) appData.description = importData.description;
      if (importData.logoURL) appData.logoURL = importData.logoURL;

      console.log("Creating app from import...");
      const result = await api.createApp(appData);

      success(`App imported: ${result.app.packageName}`);

      // Display the API key (only shown once!)
      if (result.apiKey) {
        console.log();
        console.log(chalk.yellow("⚠️  IMPORTANT: Save this API key - it won't be shown again!"));
        console.log();
        console.log(chalk.cyan("  API Key: ") + chalk.bold.white(result.apiKey));
        console.log();
      }

      // Display app details
      console.log("\nImported app details:");
      displayJSON(result.app);
    } catch (err: any) {
      if (err.code === "ENOENT") {
        error(`File not found: ${file}`);
      } else if (err instanceof SyntaxError) {
        error(`Invalid JSON file: ${err.message}`);
      } else {
        error(`Failed to import app: ${err.message}`);
      }
      process.exit(1);
    }
  });
