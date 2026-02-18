/**
 * @fileoverview Store service for MentraOS Store website.
 * Handles business logic for the store frontend including app browsing,
 * installation status, and user-specific app data.
 */

import { User, UserI } from "../../models/user.model";
import { logger as rootLogger } from "../logging/pino-logger";
import App, { AppI } from "../../models/app.model";

const logger = rootLogger.child({ service: "store.service" });

export interface AppWithInstallStatus {
  packageName: string;
  name?: string;
  description?: string;
  organizationId?: unknown;
  isInstalled: boolean;

  [key: string]: any; // Allow other app properties
}

/**
 * Get all published apps available in the store.
 * No authentication required.
 */
export async function getPublishedApps() {
  return App.find({ appStoreStatus: "PUBLISHED" });
}

/**
 * Get all published apps with installation status for a specific user.
 * Requires user email for checking installation status.
 *
 * @param user - Email of the authenticated user
 * @returns Apps with isInstalled flag added
 */
export async function getPublishedAppsForUser(user: UserI): Promise<AppWithInstallStatus[]> {
  // Get all available apps
  const apps = await getPublishedApps();

  // Get user to check which apps are installed
  const installedPackageNames = user.installedApps?.map((ia) => ia.packageName) || [];

  // Add installation status
  const appsWithStatus: AppWithInstallStatus[] = apps.map((app) => ({
    ...app,
    isInstalled: installedPackageNames.includes(app.packageName),
  }));

  return appsWithStatus;
}

/**
 * Get only the apps that a user has installed.
 *
 * @param user - User object of the authenticated user
 * @returns User's installed apps
 */
export async function getInstalledAppsForUser(user: UserI): Promise<AppI[]> {
  // Get package names from user's installed apps
  const installedPackageNames = (user.installedApps || []).map((ia) => ia.packageName);

  if (installedPackageNames.length === 0) {
    return [];
  }

  // Find all apps where packageName is in the user's installed apps list
  const apps = await App.find({
    packageName: { $in: installedPackageNames },
  }).lean();

  return apps as AppI[];
}

/**
 * Get app details by package name.
 *
 * @param packageName - Package name of the app
 * @returns App details or null if not found
 */
export async function getAppByPackageName(packageName: string) {
  const app = (await App.findOne({
    packageName: packageName,
  }).lean()) as AppI;
  return app;
}

/**
 * Search for apps by query string.
 * Searches in app name, description, and package name.
 *
 * @param query - Search query string
 * @returns Filtered apps matching the search query
 */
export async function searchApps(query: string) {
  // Use MongoDB $regex for case-insensitive search across multiple fields
  const apps = await App.find({
    appStoreStatus: "PUBLISHED",
    $or: [{ name: { $regex: query, $options: "i" } }, { packageName: { $regex: query, $options: "i" } }],
  }).lean();

  return apps as AppI[];
}

/**
 * Install an app for a user.
 *
 * @param user - User object of the authenticated user
 * @param packageName - Package name of the app to install
 * @returns Success status and message
 */
export async function installAppForUser(user: UserI, packageName: string) {
  // Verify app exists
  const app = await getAppByPackageName(packageName);
  if (!app) {
    throw new Error("App not found");
  }

  // Install app for user

  // Check if already installed
  if (user.isAppInstalled(packageName)) {
    return { alreadyInstalled: true };
  }

  await user.installApp(packageName);
  logger.info({ userId: user.email, packageName }, "App installed successfully");

  return { alreadyInstalled: false };
}

/**
 * Uninstall an app for a user.
 * Automatically stops the app if it's running.
 *
 * @param user - User object of the authenticated user
 * @param packageName - Package name of the app to uninstall
 */
export async function uninstallAppForUser(user: UserI, packageName: string) {
  // Check if app is installed
  if (!user.isAppInstalled(packageName)) {
    throw new Error("App is not installed");
  }

  // Note: App stopping logic is handled in the API layer if UserSession exists
  // This service focuses on the data layer only

  // Uninstall app
  await user.uninstallApp(packageName);
  logger.info({ userId: user.email, packageName }, "App uninstalled successfully");
}

export default {
  getPublishedApps,
  getPublishedAppsForUser,
  getInstalledAppsForUser,
  getAppByPackageName,
  searchApps,
  installAppForUser,
  uninstallAppForUser,
};
