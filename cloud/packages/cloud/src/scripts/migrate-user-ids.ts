/**
 * Migration script to backfill userId (UUID) for existing users.
 *
 * This script finds all users that do not yet have a `userId` and assigns
 * a new UUID to each. New users created after the model change will receive
 * a `userId` automatically via the schema default.
 *
 * Usage:
 *   bun run src/scripts/migrate-user-ids.ts
 */

import mongoose from "mongoose";
import dotenv from "dotenv";
import { randomUUID } from "crypto";

import { User } from "../models/user.model";
import { logger } from "../services/logging/pino-logger";
import * as mongoConnection from "../connections/mongodb.connection";

// Load environment variables
dotenv.config();

async function connectToDatabase() {
  try {
    logger.info("Initializing MongoDB connection for userId migration");
    await mongoConnection.init();
    logger.info("Successfully connected to MongoDB");
  } catch (error) {
    logger.error(error, "Failed to connect to MongoDB:");
    process.exit(1);
  }
}

async function migrateUserIds() {
  const batchSize = 500;

  try {
    const query = {
      $or: [{ userId: { $exists: false } }, { userId: null }, { userId: "" }],
    } as const;

    const total = await User.countDocuments(query);
    logger.info(`Starting userId migration. Users missing userId: ${total}`);

    let processed = 0;

    while (true) {
      const users = await User.find(query).sort({ _id: 1 }).limit(batchSize).exec();

      if (users.length === 0) {
        break;
      }

      for (const user of users) {
        try {
          user.userId = user.userId || randomUUID();
          await user.save();
          processed += 1;
        } catch (error) {
          logger.error(error, `Error updating user ${user._id} during userId migration:`);
        }
      }

      logger.info(`Processed ${processed}/${total} users in userId migration (batch size: ${batchSize})`);
    }

    logger.info(`UserId migration completed. Total users updated with userId: ${processed} (out of ${total})`);
  } catch (error) {
    logger.error(error, "Error during userId migration:");
    process.exit(1);
  }
}

async function main() {
  try {
    await connectToDatabase();
    await migrateUserIds();
    logger.info("UserId migration script finished successfully");
    process.exit(0);
  } catch (error) {
    logger.error(error, "UserId migration script failed:");
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

// Run the script
main();
