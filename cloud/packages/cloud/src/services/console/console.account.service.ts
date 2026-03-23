import { OrganizationI } from "../../models/organization.model";
import { User, UserI } from "../../models/user.model";
import { OrganizationService } from "../core/organization.service";
import { logger as rootLogger } from "../logging/pino-logger";

const logger = rootLogger.child({ service: "console.account" });

/**
 * Error type for service-layer domain errors
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
 * Result shape for console auth "me" endpoint
 */
export type ConsoleAccount = {
  id: string;
  email: string;
  orgs: Array<OrganizationI>;
  defaultOrgId: string;
};

/**
 * Get the console user identity and organizations.
 * Ensures a personal organization exists when none are present.
 *
 * - Finds (or creates) the user document
 * - Bootstraps a personal org if the user has none
 * - Returns user email, organizations list, and defaultOrgId
 */
export async function getConsoleAccount(email: string): Promise<ConsoleAccount> {
  if (!email || typeof email !== "string") {
    throw new ApiError(400, "Missing or invalid email");
  }

  // 1) Find or create the user
  const normalizedEmail = email.toLowerCase();
  let user: UserI = await User.findOrCreateUser(normalizedEmail);

  // 2) Bootstrap a personal org if the user has none
  const hasOrgs = Array.isArray(user.organizations) && user.organizations.length > 0;
  let bootstrapFailed = false;

  if (!hasOrgs) {
    try {
      // createPersonalOrg is idempotent: if the user already has an org
      // (created by a concurrent request), it returns the existing one.
      const personalOrgId = await OrganizationService.createPersonalOrg(user);

      // Use atomic $addToSet + $set instead of user.save() to avoid
      // Mongoose VersionError when concurrent requests modify the same
      // user document (e.g., findOrCreateUser and validateSupabaseToken
      // both trying to bootstrap orgs at the same time).
      await User.updateOne(
        { _id: user._id },
        {
          $addToSet: { organizations: personalOrgId },
          $set: { defaultOrg: personalOrgId },
        },
      );

      // Re-fetch the user so the in-memory object reflects the update
      const refreshed = await User.findById(user._id);
      if (refreshed) {
        user = refreshed;
      }
    } catch (orgError) {
      // Log and flag — the user may still have orgs from a concurrent
      // path that succeeded, so we continue to the list step. But if orgs
      // are still empty after listing, we surface the error instead of
      // returning a broken empty account.
      bootstrapFailed = true;
      logger.error(
        {
          error: orgError instanceof Error ? orgError.message : String(orgError),
          userEmail: normalizedEmail,
        },
        "Failed to bootstrap personal organization for console account",
      );
    }
  }

  // 3) List organizations for the user
  const orgs = await OrganizationService.listUserOrgs(user._id);

  // If bootstrap was attempted and failed, and the user still has no orgs
  // (meaning no concurrent path saved them), surface the error. Returning
  // 200 with empty orgs and blank defaultOrgId masks real DB failures and
  // leaves the console in a broken no-org state.
  if (bootstrapFailed && orgs.length === 0) {
    throw new ApiError(500, "Failed to create organization for user");
  }

  // 4) Ensure a defaultOrgId exists (prefer user.defaultOrg; else first org)
  let defaultOrgId: string | null = user.defaultOrg ? String(user.defaultOrg) : null;

  if (!defaultOrgId && orgs.length > 0) {
    defaultOrgId = String(orgs[0]._id);
    // Use atomic update to avoid VersionError
    await User.updateOne({ _id: user._id }, { $set: { defaultOrg: orgs[0]._id } });
  }

  return {
    id: String(user._id),
    email: normalizedEmail,
    orgs,
    defaultOrgId: defaultOrgId || (orgs[0] ? String(orgs[0]._id) : ""),
  };
}

export default {
  getConsoleAccount,
};
