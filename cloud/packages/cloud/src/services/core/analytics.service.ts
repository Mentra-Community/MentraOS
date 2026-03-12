/**
 * @fileoverview Analytics service for mini-app developer insights.
 * Queries the User collection to derive install counts and active user metrics.
 */

import { User } from "../../models/user.model";
import { logger as rootLogger } from "../logging/pino-logger";

const logger = rootLogger.child({ service: "analytics.service" });

export interface AppAnalytics {
  totalInstalls: number;
  dau: number;
  wau: number;
  mau: number;
  installsOverTime: { date: string; count: number }[];
}

// Simple in-memory cache with TTL
const cache = new Map<string, { data: AppAnalytics; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function getAppAnalytics(packageName: string): Promise<AppAnalytics> {
  const cached = cache.get(packageName);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [totalInstalls, dau, wau, mau, installsOverTime] = await Promise.all([
    // Total current installs
    User.countDocuments({ "installedApps.packageName": packageName }),

    // DAU — active in last 24h
    User.countDocuments({
      installedApps: { $elemMatch: { packageName, lastActiveAt: { $gte: oneDayAgo } } },
    }),

    // WAU — active in last 7 days
    User.countDocuments({
      installedApps: { $elemMatch: { packageName, lastActiveAt: { $gte: sevenDaysAgo } } },
    }),

    // MAU — active in last 30 days
    User.countDocuments({
      installedApps: { $elemMatch: { packageName, lastActiveAt: { $gte: thirtyDaysAgo } } },
    }),

    // Installs per day over last 30 days
    User.aggregate([
      { $unwind: "$installedApps" },
      {
        $match: {
          "installedApps.packageName": packageName,
          "installedApps.installedDate": { $gte: thirtyDaysAgo },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$installedApps.installedDate" },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, date: "$_id", count: 1 } },
    ]),
  ]);

  const result: AppAnalytics = {
    totalInstalls,
    dau,
    wau,
    mau,
    installsOverTime,
  };

  cache.set(packageName, { data: result, expiresAt: Date.now() + CACHE_TTL_MS });
  logger.debug({ packageName, totalInstalls, dau, wau, mau }, "Analytics computed");

  return result;
}

export default { getAppAnalytics };
