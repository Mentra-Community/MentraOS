/**
 * Migration script to add ALL permission to existing apps
 *
 * This script ensures backward compatibility by adding the ALL permission
 * to all existing apps in the database. New apps created after this migration
 * will need to explicitly define their permissions.
 *
 * Usage:
 *   bun run src/scripts/migrate-permissions.ts
 */

import mongoose from "mongoose";
import dotenv from "dotenv";
import App from "../models/app.model";
import { PermissionType } from "@mentra/sdk";
import { logger } from "../services/logging/pino-logger";
import * as mongoConnection from "../connections/mongodb.connection";

// Load environment variables
dotenv.config();

// Connect to MongoDB using the existing connection module
async function connectToDatabase() {
  try {
    logger.info("Initializing MongoDB connection");
    await mongoConnection.init();
    logger.info("Successfully connected to MongoDB");
  } catch (error) {
    logger.error(error, "Failed to connect to MongoDB:");
    process.exit(1);
  }
}

// Add ALL permission to all existing apps
async function migratePermissions() {
  try {
    logger.info("Starting permissions migration...");

    // Get all apps
    const apps = await App.find({});
    logger.info(`Found ${apps.length} apps to process`);

    let updatedCount = 0;
    let skippedCount = 0;

    // Process each app
    for (const app of apps) {
      try {
        // Skip apps that already have permissions defined
        if (app.permissions && app.permissions.length > 0) {
          logger.info(
            `Skipping app ${app.packageName}: Permissions already defined`,
          );
          skippedCount++;
          continue;
        }

        // Add ALL permission to apps without defined permissions
        app.permissions = [
          {
            type: PermissionType.ALL,
            description: "Automatically added for backward compatibility",
          },
        ];

        // Save the updated app
        await app.save();
        logger.info(`Updated app ${app.packageName}: Added ALL permission`);
        updatedCount++;
      } catch (error) {
        logger.error(error, `Error updating app ${app.packageName}:`);
        // Optionally, you can continue or break based on the error
        // continue; // or break;
      }
    }

    logger.info(`
Migration completed:
- Total apps: ${apps.length}
- Updated with ALL permission: ${updatedCount}
- Skipped (already had permissions): ${skippedCount}
    `);
  } catch (error) {
    logger.error(error, "Error during migration:");
    process.exit(1);
  }
}

// Main function
async function main() {
  try {
    await connectToDatabase();
    await migratePermissions();
    logger.info("Migration completed successfully");
    process.exit(0);
  } catch (error) {
    logger.error(error, "Migration failed:");
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

// Run the script
main();
