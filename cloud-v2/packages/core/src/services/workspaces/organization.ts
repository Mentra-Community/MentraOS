/**
 * @fileoverview Organization configuration for this Core deployment.
 *
 * An organization is one Core deployment (a cloud instance and its database).
 * It has no id of its own: a service knows which organization it talks to from
 * the Core URL it is configured with. Everything here is read from the
 * environment at use time, so a changed setting takes effect on the next call
 * and tests can set it freely. Organization Admins are the verified emails on
 * the allowlist (`admin-email-policy.ts`).
 */

/**
 * This deployment's environment label: `CLOUD_CORE_ENVIRONMENT`, else derived
 * from `CONSOLE2_URL` (`dev`, `staging`, `prod`, `local`, or the host), else
 * `local`. It is the label Core's API keys have always carried
 * (`msk_<env>_...`), so keys made before workspaces keep validating.
 */
export function deploymentEnvironmentLabel(): string {
  const explicit = process.env.CLOUD_CORE_ENVIRONMENT
  if (explicit) return explicit

  const consoleUrl = process.env.CONSOLE2_URL
  if (!consoleUrl) return "local"
  try {
    const host = new URL(consoleUrl).hostname
    if (host.includes(".dev.")) return "dev"
    if (host.includes(".staging.")) return "staging"
    if (host === "console2.mentraglass.com") return "prod"
    if (host === "localhost" || host === "127.0.0.1") return "local"
    return host
  } catch {
    return "local"
  }
}

/**
 * The environment labels credentials of this organization may carry in
 * `msk_<env>_...` / `mak_<env>_...`, the first being the one new keys get.
 * `CLOUD_CORE_CREDENTIAL_ENVIRONMENTS` (a comma list) wins; otherwise this
 * deployment's own label ({@link deploymentEnvironmentLabel}). Labels are
 * lowercased with everything outside `[a-z0-9]` stripped; a value that is blank
 * once normalized counts as unset.
 */
export function credentialEnvironmentLabels(): string[] {
  const listed = normalizeLabels(process.env.CLOUD_CORE_CREDENTIAL_ENVIRONMENTS?.split(","))
  if (listed.length > 0) return listed
  const own = normalizeLabels([deploymentEnvironmentLabel()])
  return own.length > 0 ? own : ["local"]
}

function normalizeLabels(values: Array<string | undefined> | undefined): string[] {
  const labels = (values ?? []).map(value => (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean)
  return [...new Set(labels)]
}

/** Who may create a workspace (`CLOUD_CORE_WORKSPACE_CREATION`). */
export type WorkspaceCreationPolicy = "open" | "organization-admins"

/**
 * `CLOUD_CORE_WORKSPACE_CREATION`: `open` (the default: anyone signed in with a
 * verified email) or `organization-admins` (a Private Cloud that limits
 * creation). Read at call time; an unrecognized value throws rather than
 * silently opening creation up.
 */
export function workspaceCreationPolicy(): WorkspaceCreationPolicy {
  const configured = (process.env.CLOUD_CORE_WORKSPACE_CREATION ?? "").trim().toLowerCase()
  if (configured === "" || configured === "open") return "open"
  if (configured === "organization-admins") return "organization-admins"
  throw new Error('CLOUD_CORE_WORKSPACE_CREATION must be "open" or "organization-admins"')
}

/**
 * Throws when an organization setting this module reads is malformed, so a bad
 * value stops Core at startup rather than failing its first request.
 */
export function assertOrganizationConfiguration(): void {
  workspaceCreationPolicy()
}
