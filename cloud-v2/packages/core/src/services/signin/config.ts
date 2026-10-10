/**
 * @fileoverview The deployment's identity providers for web sign-in.
 *
 * Each Core trusts one identity provider for its websites:
 *  - hosted Core: Supabase Auth (the Mentra account), configured with
 *    `CLOUD_CORE_SUPABASE_ISSUER`; its web clients are listed in
 *    `CLOUD_CORE_WEB_CLIENT_IDS`;
 *  - a Mentra Private Cloud: the one provider in `CLOUD_CORE_OIDC_PROVIDERS`
 *    that carries `browser` settings (the customer's Entra, say).
 *
 * Everything is read from the environment at use time, so tests and a changed
 * environment take effect on the next call. With none of it set, Core runs as
 * before and portal sign-in answers "not configured".
 *
 * `assertSigninConfiguration` runs at startup and refuses configuration that
 * would let one source vouch for another's people.
 */

import {EnterpriseOrgModel} from "../../models/enterprise-org.model"
import {OemModel} from "../../models/oem.model"
import {configuredOidcProviders, type ConfiguredOidcProvider} from "../oem.service"
import {isCanonicalDomain} from "./email-trust"

export const MENTRA_TENANT_ID = "mentra"
export const MENTRA_SOURCE_ID = "mentra"

/** Asymmetric algorithms accepted on Supabase tokens, verified against the project's key set. HS256 uses the JWT secret. */
export const SUPABASE_ASYMMETRIC_ALGORITHMS = ["RS256", "ES256"] as const

const RESERVED_TENANT_IDS = new Set(["mentra", "workos"])
const MENTRA_EMAIL_DOMAINS = ["mentra.glass", "mentraglass.com"]
const DEPLOYED_ENVIRONMENTS: ReadonlySet<string> = new Set(["dev", "staging", "prod", "production"])

export interface BrowserSourceSettings {
  clientId: string
  clientSecretEnv: string
  scopes: string[]
  emailClaim: string
  displayName: string
}

export type IdentityProviderKind = "supabase" | "oidc_provider"

export interface WebIdentityProvider {
  kind: IdentityProviderKind
  /** "mentra" for Supabase; the provider id otherwise. */
  sourceId: string
  /** "mentra", or the provider's tenantId: the first half of the Core user key. */
  tenantId: string
  issuer: string
  jwksUrl: string
  /** "sub" for Supabase. */
  subjectClaim: string
  directoryTenantClaim: string | null
  expectedDirectoryTenantId: string | null
  /** Supabase: RS256 and ES256 (HS256 is verified with the JWT secret). Providers: their configured list. */
  algorithms: string[]
  /** Providers only. */
  verifiedEmailDomains: string[]
  browser: BrowserSourceSettings | null
  /** Providers only: the checks on access tokens presented as bearers (the same as the phone token exchange). */
  accessToken: {audience: string; requiredScopes: string[]; allowedClientIds: string[] | null} | null
}

export class ConfigurationError extends Error {
  override name = "ConfigurationError"
}

/**
 * Whether this process is a deployed Core: `NODE_ENV=production`, or
 * `CLOUD_CORE_ENVIRONMENT` is dev, staging, prod or production. Local runs and
 * tests are not.
 */
export function isDeployedEnvironment(): boolean {
  if (process.env.NODE_ENV === "production") return true
  return DEPLOYED_ENVIRONMENTS.has((process.env.CLOUD_CORE_ENVIRONMENT ?? "").trim().toLowerCase())
}

// Each variable is read as `process.env.NAME` so the production config
// contract check (.github/scripts/validate-production-cloud-config.mjs) sees it.
function clean(value: string | undefined): string {
  return (value ?? "").trim()
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "")
}

/** The Supabase issuer this Core trusts, or null when hosted web sign-in is not configured. */
export function supabaseIssuer(): string | null {
  const issuer = clean(process.env.CLOUD_CORE_SUPABASE_ISSUER)
  return issuer ? withoutTrailingSlash(issuer) : null
}

/** Supabase's key set: `CLOUD_CORE_SUPABASE_JWKS_URL`, by default `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`. */
export function supabaseJwksUrl(issuer: string | null = supabaseIssuer()): string | null {
  const explicit = clean(process.env.CLOUD_CORE_SUPABASE_JWKS_URL)
  if (explicit) return explicit
  const projectUrl = clean(process.env.SUPABASE_URL)
  if (projectUrl) return `${withoutTrailingSlash(projectUrl)}/auth/v1/.well-known/jwks.json`
  return issuer ? `${issuer}/.well-known/jwks.json` : null
}

/** Supabase as a web identity provider, or null unless `CLOUD_CORE_SUPABASE_ISSUER` is set. */
export function supabaseProvider(): WebIdentityProvider | null {
  const issuer = supabaseIssuer()
  if (!issuer) return null
  return {
    kind: "supabase",
    sourceId: MENTRA_SOURCE_ID,
    tenantId: MENTRA_TENANT_ID,
    issuer,
    jwksUrl: supabaseJwksUrl(issuer)!,
    subjectClaim: "sub",
    directoryTenantClaim: null,
    expectedDirectoryTenantId: null,
    algorithms: [...SUPABASE_ASYMMETRIC_ALGORITHMS],
    verifiedEmailDomains: [],
    browser: null,
    accessToken: null,
  }
}

/**
 * This environment's web client IDs (`CLOUD_CORE_WEB_CLIENT_IDS`, comma
 * separated): its admin portal, enterprise portal, Console and CLI. A Supabase
 * token issued to any other client, including another environment's, is refused.
 */
export function webClientIds(): Set<string> {
  return new Set(
    clean(process.env.CLOUD_CORE_WEB_CLIENT_IDS)
      .split(",")
      .map(id => id.trim())
      .filter(Boolean),
  )
}

function toWebProvider(provider: ConfiguredOidcProvider): WebIdentityProvider {
  return {
    kind: "oidc_provider",
    sourceId: provider.id,
    tenantId: provider.tenantId,
    issuer: provider.issuer,
    jwksUrl: provider.jwksUrl,
    subjectClaim: provider.subjectClaim,
    directoryTenantClaim: provider.directoryTenantClaim ?? null,
    expectedDirectoryTenantId: provider.expectedDirectoryTenantId ?? null,
    algorithms: provider.algorithms ?? ["RS256"],
    verifiedEmailDomains: provider.verifiedEmailDomains,
    browser: provider.browser,
    accessToken: {
      audience: provider.audience,
      requiredScopes: provider.requiredScopes ?? [],
      allowedClientIds: provider.allowedClientIds ?? null,
    },
  }
}

/** The deployment OIDC providers, as web identity providers. */
export function oidcProviders(): WebIdentityProvider[] {
  return configuredOidcProviders().map(toWebProvider)
}

/**
 * The provider the admin and enterprise portals sign in with: Supabase on
 * hosted Core, otherwise the one deployment provider with `browser` settings.
 * Throws ConfigurationError when there is neither.
 */
export function portalIdentityProvider(): WebIdentityProvider {
  const supabase = supabaseProvider()
  if (supabase) return supabase
  const browser = oidcProviders().filter(provider => provider.browser)
  if (browser.length === 1) return browser[0]!
  throw new ConfigurationError("portal sign-in is not configured: set CLOUD_CORE_SUPABASE_ISSUER or a provider's browser settings")
}

export function findProviderBySourceId(sourceId: string): WebIdentityProvider | null {
  if (sourceId === MENTRA_SOURCE_ID) return supabaseProvider()
  return oidcProviders().find(provider => provider.sourceId === sourceId) ?? null
}

export function findProviderByIssuer(issuer: string): WebIdentityProvider | null {
  const supabase = supabaseProvider()
  if (supabase && supabase.issuer === withoutTrailingSlash(issuer)) return supabase
  return oidcProviders().find(provider => provider.issuer === issuer) ?? null
}

/** Whether the sign-in source behind a portal session is still configured. A removed provider's sessions end on their next request. */
export function isSourceEnabled(tenantId: string, sourceId: string): boolean {
  const provider = findProviderBySourceId(sourceId)
  return provider !== null && provider.tenantId === tenantId
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && !url.username && !url.password && !url.hash
  } catch {
    return false
  }
}

function isUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && !url.hash
  } catch {
    return false
  }
}

function isMentraDomain(domain: string): boolean {
  return MENTRA_EMAIL_DOMAINS.some(mentra => domain === mentra || domain.endsWith(`.${mentra}`))
}

/**
 * Refuse sign-in configuration that is incomplete or would let a source vouch
 * for people it does not own. Each error names the field. Runs at startup,
 * after migrations; `skipDatabase` skips the tenant-collision check against
 * OEMs and enterprises (for tests without a database).
 */
export async function assertSigninConfiguration(opts: {skipDatabase?: boolean} = {}): Promise<void> {
  let configured: ConfiguredOidcProvider[]
  try {
    configured = configuredOidcProviders()
  } catch (err) {
    throw new ConfigurationError(`CLOUD_CORE_OIDC_PROVIDERS: ${(err as Error).message}`)
  }
  const deployed = isDeployedEnvironment()
  const domainOwner = new Map<string, string>()
  let browserProviders = 0

  for (const provider of configured) {
    const label = `CLOUD_CORE_OIDC_PROVIDERS provider "${provider.id}"`
    if (RESERVED_TENANT_IDS.has(provider.tenantId)) {
      throw new ConfigurationError(`${label} tenantId "${provider.tenantId}" is reserved`)
    }
    const seen = new Set<string>()
    for (const domain of provider.verifiedEmailDomains) {
      if (!isCanonicalDomain(domain)) {
        throw new ConfigurationError(`${label} verifiedEmailDomains entry "${domain}" must be a lowercase domain without a trailing dot`)
      }
      if (seen.has(domain)) throw new ConfigurationError(`${label} verifiedEmailDomains lists "${domain}" twice`)
      seen.add(domain)
      if (isMentraDomain(domain)) {
        throw new ConfigurationError(`${label} verifiedEmailDomains must not list the Mentra domain "${domain}"`)
      }
      const owner = domainOwner.get(domain)
      if (owner) throw new ConfigurationError(`${label} verifiedEmailDomains "${domain}" is also listed by provider "${owner}"`)
      domainOwner.set(domain, provider.id)
    }
    const browser = provider.browser
    if (!browser) continue
    browserProviders++
    if (!browser.clientId) throw new ConfigurationError(`${label} browser.clientId is required`)
    if (!browser.displayName) throw new ConfigurationError(`${label} browser.displayName is required`)
    if (!browser.clientSecretEnv) throw new ConfigurationError(`${label} browser.clientSecretEnv is required`)
    if (!clean(process.env[browser.clientSecretEnv])) {
      throw new ConfigurationError(`${label} browser.clientSecretEnv names ${browser.clientSecretEnv}, which is not set`)
    }
    if (!browser.scopes.includes("openid")) throw new ConfigurationError(`${label} browser.scopes must include "openid"`)
    if (!browser.emailClaim) throw new ConfigurationError(`${label} browser.emailClaim is required`)
  }
  if (browserProviders > 1) {
    throw new ConfigurationError("CLOUD_CORE_OIDC_PROVIDERS: at most one provider may have browser settings")
  }

  const issuer = supabaseIssuer()
  if (issuer) {
    if (browserProviders > 0) {
      throw new ConfigurationError("CLOUD_CORE_SUPABASE_ISSUER and a provider's browser settings are both set; the portals sign in with one identity provider")
    }
    const jwksUrl = supabaseJwksUrl(issuer)!
    for (const [name, value] of [
      ["CLOUD_CORE_SUPABASE_ISSUER", issuer],
      ["CLOUD_CORE_SUPABASE_JWKS_URL", jwksUrl],
    ] as const) {
      if (deployed ? !isHttpsUrl(value) : !isUrl(value)) {
        throw new ConfigurationError(`${name} must be ${deployed ? "an HTTPS" : "a"} URL`)
      }
    }
    if (deployed && webClientIds().size === 0) {
      throw new ConfigurationError("CLOUD_CORE_WEB_CLIENT_IDS must list this environment's web clients when CLOUD_CORE_SUPABASE_ISSUER is set")
    }
  }

  for (const [name, raw] of [
    ["CLOUD_CORE_ADMIN_PORTAL_URL", process.env.CLOUD_CORE_ADMIN_PORTAL_URL],
    ["CLOUD_CORE_ENTERPRISE_PORTAL_URL", process.env.CLOUD_CORE_ENTERPRISE_PORTAL_URL],
    ["CLOUD_CORE_IDP_SIGNOUT_URL", process.env.CLOUD_CORE_IDP_SIGNOUT_URL],
  ] as const) {
    const value = clean(raw)
    if (value && (deployed ? !isHttpsUrl(value) : !isUrl(value))) {
      throw new ConfigurationError(`${name} must be ${deployed ? "an HTTPS" : "a"} URL`)
    }
  }

  if (!opts.skipDatabase && configured.length > 0) {
    const tenantIds = configured.map(provider => provider.tenantId)
    const [oem, enterprise] = await Promise.all([
      OemModel.findOne({tenantId: {$in: tenantIds}}, {tenantId: 1}).lean(),
      EnterpriseOrgModel.findOne({tenantId: {$in: tenantIds}}, {tenantId: 1}).lean(),
    ])
    const collision = oem?.tenantId ?? enterprise?.tenantId
    if (collision) {
      throw new ConfigurationError(`CLOUD_CORE_OIDC_PROVIDERS tenantId "${collision}" is already an ${oem ? "OEM" : "enterprise"} tenant`)
    }
  }
}
