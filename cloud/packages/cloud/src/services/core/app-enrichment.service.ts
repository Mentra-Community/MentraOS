/**
 * @fileoverview App enrichment utility for adding developer/organization profile data to apps.
 * Provides a shared function used by both Express and Hono APIs.
 */

import { Organization } from "../../models/organization.model";
import { User } from "../../models/user.model";
import { logger as rootLogger } from "../logging/pino-logger";

const logger = rootLogger.child({ service: "app-enrichment" });

/**
 * Enriches apps with developer profile and organization name data.
 * Handles both new organization-based apps and legacy developer-based apps.
 *
 * @param appsInput - Array of app objects to enrich
 * @returns Promise with enriched app objects containing orgName, developerProfile, and developerName
 */
export async function batchEnrichAppsWithProfiles(appsInput: Array<any>): Promise<Array<any>> {
  // Guard against null/undefined input
  if (!appsInput || !Array.isArray(appsInput)) {
    return [];
  }

  // Normalize to plain objects to avoid mutating Mongoose docs
  const apps = appsInput.map((a: any) => (a as any).toObject?.() || a);

  // Collect unique organization ids and developer emails
  const orgIdSet = new Set<string>();
  const developerEmailSet = new Set<string>();

  for (const app of apps) {
    if (app.organizationId) {
      try {
        orgIdSet.add(String(app.organizationId));
      } catch {
        // ignore malformed ids
      }
    }
    if (app.developerId) {
      developerEmailSet.add(String(app.developerId).toLowerCase());
    }
  }

  // Bulk fetch organizations and users
  let orgMap = new Map<string, any>();
  let userMap = new Map<string, any>();

  try {
    if (orgIdSet.size > 0) {
      const orgs = await Organization.find({
        _id: { $in: Array.from(orgIdSet) },
      }).lean();
      orgMap = new Map(orgs.map((o: any) => [String(o._id), o]));
    }
  } catch (e) {
    logger.warn({ e }, "Failed to batch-load organizations for app enrichment");
  }

  try {
    if (developerEmailSet.size > 0) {
      const users = await User.find({
        email: { $in: Array.from(developerEmailSet) },
      }).lean();
      userMap = new Map(users.map((u: any) => [String(u.email).toLowerCase(), u]));
    }
  } catch (e) {
    logger.warn({ e }, "Failed to batch-load users for app enrichment");
  }

  // Apply enrichment
  return apps.map((app: any) => {
    const enriched = { ...app } as any;
    let enrichmentFound = false;

    // Try organization first
    if (app.organizationId) {
      const key = String(app.organizationId);
      const org = orgMap.get(key);
      if (org) {
        enriched.developerProfile = org.profile || {};
        enriched.orgName = org.name;
        enriched.developerName = org.name;
        enrichmentFound = true;
      }
    }

    // Fallback to developer if organization not found
    if (!enrichmentFound && app.developerId) {
      const user = userMap.get(String(app.developerId).toLowerCase());
      if (user && user.profile) {
        const displayName =
          user.profile.company ||
          (String(user.email).includes("@") ? String(user.email).split("@")[0] : String(user.email));
        enriched.developerProfile = user.profile;
        enriched.orgName = displayName;
        enriched.developerName = displayName;
        enrichmentFound = true;
      }
    }

    // Fallback: If still no orgName, infer from package name for Mentra/Augmentos apps
    if (!enriched.orgName) {
      if (
        app.packageName?.startsWith("com.mentra") ||
        app.packageName?.startsWith("cloud.augmentos") ||
        app.packageName?.startsWith("com.augmentos")
      ) {
        enriched.orgName = "Mentra";
        enriched.developerName = "Mentra";
        enriched.developerProfile = {
          company: "Mentra",
        };
      }
    }

    return enriched;
  });
}
