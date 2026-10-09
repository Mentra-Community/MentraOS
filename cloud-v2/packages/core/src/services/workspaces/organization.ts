/**
 * @fileoverview Organization configuration for this Core deployment.
 *
 * An organization is one Core deployment (a cloud instance and its database).
 * It has no id of its own: a service knows which organization it talks to from
 * the Core URL it is configured with. Everything here is read from the
 * environment at use time, so a changed allowlist or label takes effect on the
 * next call and tests can set it freely.
 */

/** The `CLOUD_CORE_ENVIRONMENT` labels of a deployed Core (shared infrastructure, real data). */
const DEPLOYED_ENVIRONMENTS: ReadonlySet<string> = new Set(["dev", "staging", "prod", "production"])

/**
 * Whether this process is a deployed Core: `NODE_ENV=production`, or
 * `CLOUD_CORE_ENVIRONMENT` (case-insensitive, trimmed) is `dev`, `staging`,
 * `prod` or `production`. Deployed Cores set the label and not `NODE_ENV`, so
 * the label has to count. Local runs, tests and an unlabeled process are not.
 */
export function isDeployedEnvironment(): boolean {
  if (process.env.NODE_ENV === "production") return true
  return DEPLOYED_ENVIRONMENTS.has((process.env.CLOUD_CORE_ENVIRONMENT ?? "").trim().toLowerCase())
}

export interface OrganizationAdminAllowlist {
  emails: string[]
  domains: string[]
}

/** The configured Organization Admin allowlist (`CLOUD_CORE_ADMIN_EMAILS`, `CLOUD_CORE_ADMIN_EMAIL_DOMAINS`). */
export function configuredAdminAllowlist(): OrganizationAdminAllowlist {
  return {
    emails: parseList(process.env.CLOUD_CORE_ADMIN_EMAILS),
    domains: parseList(process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS).map(domain => domain.replace(/^@/, "")),
  }
}

/**
 * Whether `email` is on the configured allowlist: an exact address, a plus-tagged
 * alias of a listed address (`name+tag@domain` for `name@domain`), or exactly one
 * of the listed domains (no subdomains). Only the submitted address loses its tag:
 * a listed tagged address does not admit its base mailbox or sibling tags. This is
 * the bare list match and does not know whether the address was verified, so use
 * it only for display and classification. Authorization goes through
 * {@link isOrganizationAdminEmail}. Pass `allowlist` to match many addresses
 * against one read of the config.
 */
export function isConfiguredOrganizationAdminEmail(
  email: string | null | undefined,
  allowlist: OrganizationAdminAllowlist = configuredAdminAllowlist(),
): boolean {
  const normalized = email?.trim().toLowerCase()
  if (!normalized) return false
  const [local, domain, ...extra] = normalized.split("@")
  if (!local || !domain || extra.length > 0 || /\s/.test(normalized)) return false
  const plus = local.indexOf("+")
  const base = plus > 0 && plus < local.length - 1 ? `${local.slice(0, plus)}@${domain}` : normalized
  return allowlist.emails.includes(normalized) || allowlist.emails.includes(base) || allowlist.domains.includes(domain)
}

/**
 * Whether an identity is an Organization Admin. Only an email the identity
 * provider has verified counts, so claiming an allowlisted address is not enough.
 */
export function isOrganizationAdminEmail(email: string | null, emailVerified: boolean): boolean {
  return emailVerified && isConfiguredOrganizationAdminEmail(email)
}

/**
 * The environment labels credentials of this organization may carry in
 * `msk_<env>_...` / `mak_<env>_...`. `CLOUD_CORE_CREDENTIAL_ENVIRONMENTS` (a
 * comma list) wins, then `CLOUD_CORE_ENVIRONMENT`, then `local`. Labels are
 * lowercased with everything outside `[a-z0-9]` stripped; a value that is blank
 * once normalized counts as unset.
 */
export function credentialEnvironmentLabels(): string[] {
  const listed = normalizeLabels(process.env.CLOUD_CORE_CREDENTIAL_ENVIRONMENTS?.split(","))
  if (listed.length > 0) return listed
  const single = normalizeLabels([process.env.CLOUD_CORE_ENVIRONMENT])
  return single.length > 0 ? single : ["local"]
}

function normalizeLabels(values: Array<string | undefined> | undefined): string[] {
  const labels = (values ?? []).map(value => (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean)
  return [...new Set(labels)]
}

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map(part => part.trim().toLowerCase())
    .filter(Boolean)
}
