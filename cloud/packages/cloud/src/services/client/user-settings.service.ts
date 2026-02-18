// services/core/user-settings.service.ts
// Business logic for managing user settings

import { UserSettings } from "../../models/user-settings.model";
import { User } from "../../models/user.model";
import { logger } from "../logging/pino-logger";

/**
 * Find settings document by email
 */
export async function findByEmail(email: string) {
  const normalizedEmail = email.toLowerCase().trim();
  return UserSettings.findOne({ email: normalizedEmail });
}

/**
 * Find or create settings document for a user
 */
export async function findOrCreateForUser(email: string) {
  const normalizedEmail = email.toLowerCase().trim();
  let userSettings = await UserSettings.findOne({ email: normalizedEmail });

  if (!userSettings) {
    userSettings = await UserSettings.create({
      email: normalizedEmail,
      settings: new Map(),
      lastUpdated: new Date(),
    });

    logger.info(`Created settings document for user ${normalizedEmail}`);
  }

  return userSettings;
}

/**
 * Get all settings for a user
 */
export async function getUserSettings(
  email: string,
): Promise<Record<string, any>> {
  const userSettings = await findByEmail(email);
  return userSettings?.getSettings() || {};
}

/**
 * Update settings for a user
 */
export async function updateUserSettings(
  email: string,
  settings: Record<string, any>,
): Promise<Record<string, any>> {
  const normalizedEmail = email.toLowerCase().trim();

  // Verify user exists
  const user = await User.findOne({ email: normalizedEmail });
  if (!user) {
    throw new Error("User not found");
  }

  const userSettings = await findOrCreateForUser(normalizedEmail);
  await userSettings.updateSettings(settings);

  logger.info(
    {
      email: normalizedEmail,
      updatedKeys: Object.keys(settings),
    },
    `User settings updated`,
  );

  return userSettings.getSettings();
}

/**
 * Get a specific setting by key
 */
export async function getUserSetting(email: string, key: string): Promise<any> {
  const userSettings = await findByEmail(email);
  return userSettings?.getSetting(key);
}

/**
 * Set a specific setting
 */
export async function setUserSetting(
  email: string,
  key: string,
  value: any,
): Promise<void> {
  const userSettings = await findOrCreateForUser(email);
  await userSettings.setSetting(key, value);

  logger.info(
    {
      email: email.toLowerCase().trim(),
      key,
    },
    `User setting updated`,
  );
}

/**
 * Delete a specific setting
 */
export async function deleteUserSetting(
  email: string,
  key: string,
): Promise<void> {
  const userSettings = await findByEmail(email);
  if (userSettings) {
    await userSettings.deleteSetting(key);

    logger.info(
      {
        email: email.toLowerCase().trim(),
        key,
      },
      `User setting deleted`,
    );
  }
}

/**
 * Delete all settings for a user (for cleanup)
 */
export async function deleteAllUserSettings(email: string): Promise<boolean> {
  const normalizedEmail = email.toLowerCase().trim();
  const result = await UserSettings.findOneAndDelete({
    email: normalizedEmail,
  });

  if (result) {
    logger.info(`All settings deleted for user ${normalizedEmail}`);
  }

  return !!result;
}

/**
 * Get user with settings in single optimized query
 * Use this when you always need both user + settings
 */
export async function getUserWithSettings(email: string): Promise<
  | (typeof User & {
      settings: Record<string, any>;
      settingsLastUpdated?: Date;
    })
  | null
> {
  const normalizedEmail = email.toLowerCase().trim();

  const result = await User.aggregate([
    { $match: { email: normalizedEmail } },
    {
      $lookup: {
        from: "usersettings",
        localField: "email",
        foreignField: "email",
        as: "userSettings",
      },
    },
    {
      $addFields: {
        settings: {
          $ifNull: [{ $arrayElemAt: ["$userSettings.settings", 0] }, {}],
        },
        settingsLastUpdated: {
          $arrayElemAt: ["$userSettings.lastUpdated", 0],
        },
      },
    },
    {
      $unset: "userSettings", // Remove the lookup array from response
    },
  ]);

  return result[0] || null;
}

/**
 * Batch get multiple users with their settings
 */
export async function getBatchUsersWithSettings(emails: string[]) {
  const normalizedEmails = emails.map((email) => email.toLowerCase().trim());

  return User.aggregate([
    { $match: { email: { $in: normalizedEmails } } },
    {
      $lookup: {
        from: "usersettings",
        localField: "email",
        foreignField: "email",
        as: "userSettings",
      },
    },
    {
      $addFields: {
        settings: {
          $ifNull: [{ $arrayElemAt: ["$userSettings.settings", 0] }, {}],
        },
      },
    },
    { $unset: "userSettings" },
  ]);
}
