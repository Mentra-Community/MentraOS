import { Types } from "mongoose";
import App from "../../models/app.model";
import { User, UserI } from "../../models/user.model";
import { OrganizationService } from "../core/organization.service";
import { generateApiKey, hashApiKey } from "../core/developer.service";
import { slackService } from "../notifications/slack.service";
import { logger as rootLogger } from "../logging/pino-logger";
const logger = rootLogger.child({ service: "console.apps.service" });


/**
 * Auto-install an app for the developer who created it.
 * This ensures the developer can immediately test their app without manual installation.
 */
async function autoInstallAppForDeveloper(packageName: string, user: UserI): Promise<void> {
  try {
    if (user.installedApps?.some((app) => app.packageName === packageName)) {
      return;
    }
    if (!user.installedApps) {
      user.installedApps = [];
    }
    user.installedApps.push({ packageName, installedDate: new Date() });
    await user.save();
    logger.info({ packageName, email: user.email }, "Auto-installed app for developer");
  } catch (error) {
    logger.error({ error, packageName, email: user.email }, "Error auto-installing app for developer");
  }
}
/**
 * Typed service-layer error that carries an HTTP status code.
 * Route handlers should map this to res.status(err.statusCode).
 */
export class ApiError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.name = "ApiError";
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

/**
 * Remove sensitive fields and normalize an app document for API responses.
 */
function sanitizeApp(doc: any): any {
  if (!doc || typeof doc !== "object") return doc;
  const { hashedApiKey: _hashedApiKey, ...rest } = doc;
  return { ...rest };
}

/**
 * Try to convert a string to ObjectId, throw ApiError(400) if invalid.
 */
function toObjectId(id: string, fieldName = "id"): Types.ObjectId {
  try {
    return new Types.ObjectId(id);
  } catch {
    throw new ApiError(400, `Invalid ${fieldName}`);
  }
}

/**
 * Resolve the console user by email (create if missing).
 */
async function getOrCreateUserByEmail(email: string): Promise<UserI> {
  if (!email || typeof email !== "string") {
    throw new ApiError(400, "Missing or invalid email");
  }
  const normalized = email.toLowerCase();
  try {
    return await User.findOrCreateUser(normalized);
  } catch {
    throw new ApiError(500, "Failed to resolve user");
  }
}

/**
 * List apps visible to the console user.
 * - If orgId provided: returns apps owned by that org (membership required).
 * - Else: returns apps across all orgs the user is a member of (union).
 */
export async function listApps(
  email: string,
  opts?: { orgId?: string },
): Promise<any[]> {
  const user = await getOrCreateUserByEmail(email);
  const orgId = opts?.orgId;

  try {
    if (orgId) {
      const orgObjectId = toObjectId(orgId, "orgId");

      // Verify user is a member of the org
      const isMember = await OrganizationService.isOrgMember(user, orgObjectId);
      if (!isMember) {
        throw new ApiError(
          403,
          "Insufficient permissions for this organization",
        );
      }

      const apps = await App.find({ organizationId: orgObjectId }).lean();
      return apps.map(sanitizeApp);
    }

    // No orgId provided: list apps across user's organizations
    const usersOrgs = Array.isArray(user.organizations)
      ? user.organizations
      : [];
    if (usersOrgs.length === 0) {
      return [];
    }

    const apps = await App.find({
      organizationId: { $in: usersOrgs },
    }).lean();

    return apps.map(sanitizeApp);
  } catch (err: any) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(500, "Failed to list apps");
  }
}

/**
 * Resolve an organization for a write operation:
 * - Prefer explicit orgId.
 * - Else use user.defaultOrg.
 * - Else create a personal org and set as default.
 */
async function resolveOrgForWrite(
  user: UserI,
  opts?: { orgId?: string },
): Promise<Types.ObjectId> {
  if (opts?.orgId) {
    return toObjectId(opts.orgId, "orgId");
  }
  if (user.defaultOrg) {
    return user.defaultOrg as Types.ObjectId;
  }
  // Mandatory bootstrap if user has no orgs/defaultOrg
  const personalOrgId = await OrganizationService.createPersonalOrg(user);
  if (!user.organizations) user.organizations = [];
  user.organizations.push(personalOrgId);
  user.defaultOrg = personalOrgId;
  await user.save();
  return personalOrgId;
}

/**
 * Create a new app under an organization the user admins.
 */
export async function createApp(
  email: string,
  appInput: Record<string, unknown>,
  opts?: { orgId?: string },
): Promise<{ app: any; apiKey: string }> {
  const user = await getOrCreateUserByEmail(email);

  // Validate required fields
  const packageNameRaw = appInput?.["packageName"];
  if (
    typeof packageNameRaw !== "string" ||
    packageNameRaw.trim().length === 0
  ) {
    throw new ApiError(400, "packageName is required");
  }
  const packageName = packageNameRaw.trim();

  // Ensure package uniqueness
  const existing = await App.findOne({ packageName }).lean();
  if (existing) {
    throw new ApiError(
      409,
      `App with packageName '${packageName}' already exists`,
    );
  }

  // Resolve org for write
  const orgObjectId = await resolveOrgForWrite(user, opts);

  // Verify admin rights in org
  const isAdmin = await OrganizationService.isOrgAdmin(user, orgObjectId);
  if (!isAdmin) {
    throw new ApiError(
      403,
      "Insufficient permissions to create app in this organization",
    );
  }

  // Generate and hash API key
  const apiKey = generateApiKey();
  const hashed = hashApiKey(apiKey);

  // Prepare app document - only include allowed fields
  const allowedFields = [
    "name",
    "description",
    "publicUrl",
    "appType",
    "tools",
    "permissions",
    "settings",
    "hardwareRequirements",
    "onboardingInstructions",
  ] as const;

  const doc: any = {
    packageName,
    organizationId: orgObjectId,
    developerId: user.email, // keep for audit/migration
    hashedApiKey: hashed,
  };

  for (const key of allowedFields) {
    if (key in appInput) {
      doc[key] = appInput[key];
    }
  }

  try {
    const created = await App.create(doc);
    const leanCreated = (await App.findById(created._id).lean()) || doc;

    // Notify Slack about the new mini app submission (fire-and-forget)
    slackService.notifyMiniAppSubmission(
      {
        name: leanCreated.name,
        packageName: leanCreated.packageName,
        appType: leanCreated.appType,
        description: leanCreated.description,
      },
      email,
    ).catch(() => {});

    // Auto-install the app for the developer who created it
    await autoInstallAppForDeveloper(packageName, user);

    return {
      app: sanitizeApp(leanCreated),
      apiKey, // return plaintext once
    };
  } catch (err: any) {
    const _logger = logger.child({ userId: email });
    _logger.error(err, "Failed to create app");
    throw new ApiError(500, "Failed to create app");
  }
}

/**
 * Get a single app by packageName (must belong to an org the user is a member of).
 */
export async function getApp(email: string, packageName: string): Promise<any> {
  if (!packageName) throw new ApiError(400, "packageName is required");
  const user = await getOrCreateUserByEmail(email);

  const app = await App.findOne({ packageName }).lean();
  if (!app) throw new ApiError(404, "App not found");

  // Ensure user is member of owning org
  if (app.organizationId) {
    const isMember = await OrganizationService.isOrgMember(
      user,
      app.organizationId,
    );
    if (!isMember) throw new ApiError(403, "Forbidden");
  }
  return sanitizeApp(app);
}

/**
 * Update an app (must be admin of the owning org).
 */
export async function updateApp(
  email: string,
  packageName: string,
  patch: Record<string, unknown>,
): Promise<any> {
  if (!packageName) throw new ApiError(400, "packageName is required");
  const user = await getOrCreateUserByEmail(email);

  const appDoc = await App.findOne({ packageName });
  if (!appDoc) throw new ApiError(404, "App not found");

  // Admin check
  if (appDoc.organizationId) {
    const isAdmin = await OrganizationService.isOrgAdmin(
      user,
      appDoc.organizationId,
    );
    if (!isAdmin) throw new ApiError(403, "Forbidden");
  } else {
    throw new ApiError(409, "App has no organizationId");
  }

  // Sanitize patch: prevent dangerous fields from being modified
  const forbidden = new Set([
    "_id",
    "id",
    "packageName",
    "organizationId",
    "developerId",
    "hashedApiKey",
    "createdAt",
    "updatedAt",
  ]);
  const update: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!forbidden.has(k)) update[k] = v;
  }

  const updated = await App.findOneAndUpdate(
    { packageName },
    { $set: update },
    { new: true },
  ).lean();

  return sanitizeApp(updated);
}

/**
 * Delete an app (must be admin of the owning org).
 */
export async function deleteApp(
  email: string,
  packageName: string,
): Promise<void> {
  if (!packageName) throw new ApiError(400, "packageName is required");
  const user = await getOrCreateUserByEmail(email);

  const appDoc = await App.findOne({ packageName });
  if (!appDoc) throw new ApiError(404, "App not found");

  // Admin check
  if (appDoc.organizationId) {
    const isAdmin = await OrganizationService.isOrgAdmin(
      user,
      appDoc.organizationId,
    );
    if (!isAdmin) throw new ApiError(403, "Forbidden");
  } else {
    throw new ApiError(409, "App has no organizationId");
  }

  await App.deleteOne({ packageName });
}

/**
 * Publish an app (must be admin of the owning org).
 * For now, toggle appStoreStatus to "PUBLISHED".
 */
export async function publishApp(
  email: string,
  packageName: string,
): Promise<any> {
  if (!packageName) throw new ApiError(400, "packageName is required");
  const user = await getOrCreateUserByEmail(email);

  const appDoc = await App.findOne({ packageName });
  if (!appDoc) throw new ApiError(404, "App not found");

  if (appDoc.organizationId) {
    const isAdmin = await OrganizationService.isOrgAdmin(
      user,
      appDoc.organizationId,
    );
    if (!isAdmin) throw new ApiError(403, "Forbidden");
  } else {
    throw new ApiError(409, "App has no organizationId");
  }

  appDoc.appStoreStatus = "PUBLISHED";
  await appDoc.save();

  const lean = await App.findById(appDoc._id).lean();
  return sanitizeApp(lean);
}

/**
 * Regenerate API key (must be admin of the owning org).
 * Returns plaintext apiKey once; stores hash.
 */
export async function regenerateApiKey(
  email: string,
  packageName: string,
): Promise<{ apiKey: string; createdAt?: string }> {
  if (!packageName) throw new ApiError(400, "packageName is required");
  const user = await getOrCreateUserByEmail(email);

  const appDoc = await App.findOne({ packageName });
  if (!appDoc) throw new ApiError(404, "App not found");

  if (appDoc.organizationId) {
    const isAdmin = await OrganizationService.isOrgAdmin(
      user,
      appDoc.organizationId,
    );
    if (!isAdmin) throw new ApiError(403, "Forbidden");
  } else {
    throw new ApiError(409, "App has no organizationId");
  }

  const apiKey = generateApiKey();
  const hashed = hashApiKey(apiKey);

  appDoc.hashedApiKey = hashed;
  await appDoc.save();

  return { apiKey, createdAt: new Date().toISOString() };
}

/**
 * Move app to a different organization (user must be admin in both).
 */
export async function moveApp(
  email: string,
  packageName: string,
  targetOrgId: string,
): Promise<any> {
  if (!packageName) throw new ApiError(400, "packageName is required");
  if (!targetOrgId) throw new ApiError(400, "targetOrgId is required");
  const user = await getOrCreateUserByEmail(email);

  const appDoc = await App.findOne({ packageName });
  if (!appDoc) throw new ApiError(404, "App not found");

  if (!appDoc.organizationId) {
    throw new ApiError(409, "App has no organizationId");
  }

  const sourceOrgId = appDoc.organizationId;

  // Admin in source
  const isAdminSource = await OrganizationService.isOrgAdmin(user, sourceOrgId);
  if (!isAdminSource) throw new ApiError(403, "Forbidden (source org)");

  // Admin in target
  const targetObjectId = toObjectId(targetOrgId, "targetOrgId");
  const isAdminTarget = await OrganizationService.isOrgAdmin(
    user,
    targetObjectId,
  );
  if (!isAdminTarget) throw new ApiError(403, "Forbidden (target org)");

  // Update app
  appDoc.organizationId = targetObjectId;
  await appDoc.save();

  const lean = await App.findById(appDoc._id).lean();
  return sanitizeApp(lean);
}

/**
 * Get app permissions (must be org member).
 * Reads the "permissions" array from the App document.
 */
export async function getPermissions(
  email: string,
  packageName: string,
): Promise<{ permissions: any[] }> {
  if (!packageName) throw new ApiError(400, "packageName is required");
  const user = await getOrCreateUserByEmail(email);

  const app = await App.findOne({ packageName }).lean();
  if (!app) throw new ApiError(404, "App not found");

  if (app.organizationId) {
    const isMember = await OrganizationService.isOrgMember(
      user,
      app.organizationId,
    );
    if (!isMember) throw new ApiError(403, "Forbidden");
  } else {
    throw new ApiError(409, "App has no organizationId");
  }

  return { permissions: Array.isArray(app.permissions) ? app.permissions : [] };
}

/**
 * Update app permissions (admin only).
 * Overwrites the App "permissions" array with the provided one.
 */
export async function updatePermissions(
  email: string,
  packageName: string,
  permissions: any[],
): Promise<{ permissions: any[] }> {
  if (!packageName) throw new ApiError(400, "packageName is required");
  const user = await getOrCreateUserByEmail(email);

  const appDoc = await App.findOne({ packageName });
  if (!appDoc) throw new ApiError(404, "App not found");

  if (appDoc.organizationId) {
    const isAdmin = await OrganizationService.isOrgAdmin(
      user,
      appDoc.organizationId,
    );
    if (!isAdmin) throw new ApiError(403, "Forbidden");
  } else {
    throw new ApiError(409, "App has no organizationId");
  }

  appDoc.permissions = Array.isArray(permissions) ? permissions : [];
  await appDoc.save();

  const lean = await App.findById(appDoc._id).lean();
  return {
    permissions: Array.isArray(lean?.permissions)
      ? (lean as any).permissions
      : [],
  };
}

/**
 * Get a share/install link for this app (must be org member).
 * Returns an app store URL that clients can share with testers or users.
 */
export async function getShareLink(
  email: string,
  packageName: string,
): Promise<{ installUrl: string }> {
  if (!packageName) throw new ApiError(400, "packageName is required");
  const user = await getOrCreateUserByEmail(email);

  const app = await App.findOne({ packageName }).lean();
  if (!app) throw new ApiError(404, "App not found");

  if (app.organizationId) {
    const isMember = await OrganizationService.isOrgMember(
      user,
      app.organizationId,
    );
    if (!isMember) throw new ApiError(403, "Forbidden");
  } else {
    throw new ApiError(409, "App has no organizationId");
  }

  const base = process.env.APP_STORE_URL || "https://apps.mentra.glass";
  const installUrl = `${base}/package/${encodeURIComponent(packageName)}`;
  return { installUrl };
}

/**
 * Track that this app was shared with specific emails (must be org member).
 * For MVP, this is a no-op that acknowledges the request.
 */
export async function trackSharing(
  email: string,
  packageName: string,
  emails: string[],
): Promise<{ success: boolean; sharedWith: number }> {
  if (!packageName) throw new ApiError(400, "packageName is required");
  const user = await getOrCreateUserByEmail(email);

  const app = await App.findOne({ packageName }).lean();
  if (!app) throw new ApiError(404, "App not found");

  if (app.organizationId) {
    const isMember = await OrganizationService.isOrgMember(
      user,
      app.organizationId,
    );
    if (!isMember) throw new ApiError(403, "Forbidden");
  } else {
    throw new ApiError(409, "App has no organizationId");
  }

  // In the future, persist sharing events or emit audit logs.
  const count =
    Array.isArray(emails) &&
    emails.every((e) => typeof e === "string" && e.includes("@"))
      ? emails.length
      : 0;

  return { success: true, sharedWith: count };
}
