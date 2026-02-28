/**
 * Client Apps Service
 *
 * Provides minimal app list for mobile client home screen display.
 * Fast, focused, no bloat - <100ms response time target.
 *
 * Uses @mentra/types for client-facing interfaces.
 */

import { AppletInterface } from "@mentra/types";
import { User } from "../../models/user.model";
import App from "../../models/app.model";
import UserSession from "../session/UserSession";
import { logger as rootLogger } from "../logging/pino-logger";

const logger = rootLogger.child({ service: "ClientAppsService" });

export class ClientAppsService {
  /**
   * Get minimal app list for home screen display
   *
   * Performance targets:
   * - Response time: <100ms
   * - DB queries: 2 (user + apps)
   *
   * @param userId - User email
   * @returns Array of apps with minimal fields for home screen
   */
  static async getAppsForHomeScreen(userId: string): Promise<AppletInterface[]> {
    const startTime = Date.now();

    try {
      // 1. Get user's installed apps (single query, minimal fields)
      const user = await User.findOne({ email: userId }).select("installedApps").lean();

      if (!user?.installedApps?.length) {
        logger.debug({ userId }, "No installed apps found");
        return [];
      }

      const packageNames = user.installedApps.map((a: any) => a.packageName);

      // 2. Build a map of packageName -> { installedDate, lastActiveAt } for quick lookup
      const installInfoMap = new Map<string, { installedDate?: Date; lastActiveAt?: Date }>();
      for (const installedApp of user.installedApps) {
        installInfoMap.set(installedApp.packageName, {
          installedDate: installedApp.installedDate,
          lastActiveAt: installedApp.lastActiveAt,
        });
      }

      // 3. Fetch app details (single query, only needed fields)
      const apps = await App.find({ packageName: { $in: packageNames } })
        .select("packageName name logoURL webviewURL appType permissions hardwareRequirements")
        .lean();

      if (!apps.length) {
        logger.warn({ userId, packageNames }, "No apps found in database");
        return [];
      }

      // 4. Get session state (in-memory, fast)
      const session = UserSession.getById(userId);
      const runningApps = session?.runningApps || new Set<string>();

      // 5. Get cached health status (in-memory, no external calls)
      const healthCache = session?.appHealthCache || new Map<string, boolean>();

      // 6. Map to minimal interface with install dates
      const result: AppletInterface[] = apps.map((app: any) => {
        const installInfo = installInfoMap.get(app.packageName);
        return {
          packageName: app.packageName,
          name: app.name,
          webviewUrl: app.webviewURL || "",
          logoUrl: app.logoURL,
          type: app.appType as AppletInterface["type"],
          permissions: app.permissions || [],
          running: runningApps.has(app.packageName),
          healthy: healthCache.get(app.packageName) ?? true,
          hardwareRequirements: app.hardwareRequirements || [],
          // Include install date and last active timestamp for "new app" detection
          installedDate: installInfo?.installedDate?.toISOString(),
          lastActiveAt: installInfo?.lastActiveAt?.toISOString(),
        };
      });

      const duration = Date.now() - startTime;
      logger.debug({ userId, count: result.length, duration }, "Fetched apps for home screen");

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error({ error, userId, duration }, "Failed to fetch apps for home screen");
      throw error;
    }
  }
}
