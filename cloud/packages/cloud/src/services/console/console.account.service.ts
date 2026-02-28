import { OrganizationI } from "../../models/organization.model";
import { User, UserI } from "../../models/user.model";
import { OrganizationService } from "../core/organization.service";

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
 * ensures a personal organization exists when none are present.
 *
 * - Finds (or creates) the user document
 * - bootstraps a personal org if the user has none
 * - Returns user email, organizations list, and defaultOrgId
 *
 */
export async function getConsoleAccount(
  email: string,
): Promise<ConsoleAccount> {
  if (!email || typeof email !== "string") {
    throw new ApiError(400, "Missing or invalid email");
  }

  // 1) Find or create the user
  const normalizedEmail = email.toLowerCase();
  const user: UserI = await User.findOrCreateUser(normalizedEmail);

  // 2) Bootstrap a personal org if the user has none and allowed
  const hasOrgs =
    Array.isArray(user.organizations) && user.organizations.length > 0;

  if (!hasOrgs) {
    const personalOrgId = await OrganizationService.createPersonalOrg(user);

    // Ensure user.organizations contains the new org and set as default
    if (!user.organizations) {
      user.organizations = [];
    }
    user.organizations.push(personalOrgId);
    user.defaultOrg = personalOrgId;
    await user.save();
  }

  // 3) List organizations for the user
  const orgs = await OrganizationService.listUserOrgs(user._id);

  // 4) Ensure a defaultOrgId exists (prefer user.defaultOrg; else first org)
  let defaultOrgId: string | null = user.defaultOrg
    ? String(user.defaultOrg)
    : null;

  if (!defaultOrgId && orgs.length > 0) {
    defaultOrgId = orgs[0]._id;
    // Persist the default for future requests
    user.defaultOrg = orgs[0]._id;
    await user.save();
  }

  return {
    id: String(user._id),
    email: normalizedEmail,
    orgs,
    defaultOrgId: defaultOrgId || orgs[0]?._id || "",
  };
}

export default {
  getConsoleAccount,
};
