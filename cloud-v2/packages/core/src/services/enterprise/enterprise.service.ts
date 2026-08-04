import { ulid } from "ulid";
import { EnterpriseOrgModel, type EnterpriseOrg } from "../../models/enterprise-org.model";
import { OemModel } from "../../models/oem.model";
import { TrustedIssuerModel, type TrustedIssuer } from "../../models/trusted-issuer.model";

export interface EnterpriseUserIdentity {
  id: string;
  email: string;
}

export interface UpsertEnterpriseOrgInput {
  displayName: string;
  tenantId: string;
}

export interface UpsertTrustedIssuerInput {
  environmentName: string;
  issuer: string;
  jwksUrl: string;
  subjectClaim?: string | null;
  enabled?: boolean;
}

export class EnterpriseService {
  async getPrimaryOrgForUser(user: EnterpriseUserIdentity) {
    const org = await EnterpriseOrgModel.findOne({ ownerUserId: user.id })
      .sort({ createdAt: 1 })
      .lean();
    return org ? serializeEnterpriseOrg(org) : null;
  }

  async upsertPrimaryOrg(user: EnterpriseUserIdentity, input: UpsertEnterpriseOrgInput) {
    const displayName = normalizeDisplayName(input.displayName);
    const tenantId = normalizeTenantId(input.tenantId);
    const slug = slugify(displayName);
    const existing = await EnterpriseOrgModel.findOne({ ownerUserId: user.id }).sort({ createdAt: 1 });

    if (!existing) {
      await assertTenantIdAvailable(tenantId);
      const created = await EnterpriseOrgModel.create({
        enterpriseOrgId: `ent_${ulid()}`,
        ownerUserId: user.id,
        tenantId,
        displayName,
        slug: await uniqueSlug(slug),
        status: "active",
      });
      return serializeEnterpriseOrg(created.toObject());
    }

    existing.displayName = displayName;
    if (existing.tenantId !== tenantId) {
      const issuerCount = await TrustedIssuerModel.countDocuments({ enterpriseOrgId: existing.enterpriseOrgId });
      if (issuerCount > 0) {
        throw new EnterpriseServiceError("tenant_id_locked", "Tenant ID cannot change after trusted issuers are created", 409);
      }
      await assertTenantIdAvailable(tenantId);
      existing.tenantId = tenantId;
    }
    await existing.save();
    return serializeEnterpriseOrg(existing.toObject());
  }

  async listTrustedIssuers(user: EnterpriseUserIdentity) {
    const org = await this.requirePrimaryOrg(user);
    const issuers = await TrustedIssuerModel.find({ enterpriseOrgId: org.id })
      .sort({ environmentName: 1 })
      .lean();
    return { org, issuers: issuers.map(serializeTrustedIssuer) };
  }

  async upsertTrustedIssuer(user: EnterpriseUserIdentity, input: UpsertTrustedIssuerInput) {
    const org = await this.requirePrimaryOrg(user);
    const environmentName = normalizeEnvironmentName(input.environmentName);
    const issuer = normalizeHttpsUrl(input.issuer, "issuer");
    const jwksUrl = normalizeHttpsUrl(input.jwksUrl, "JWKS URL");
    const subjectClaim = normalizeSubjectClaim(input.subjectClaim);

    // Lookup/uniqueness is scoped to (enterpriseOrgId, environmentName): one
    // trusted issuer per env per org. The same `issuer` URL may be reused across
    // envs/orgs because token exchange keys on the minted (tenantId, env) claims and
    // only pins `iss` at verify time, so it is no longer globally unique.
    const existingEnvironment = await TrustedIssuerModel.findOne({
      enterpriseOrgId: org.id,
      environmentName,
    });

    const target = existingEnvironment ?? new TrustedIssuerModel({
      trustedIssuerId: `ti_${ulid()}`,
      enterpriseOrgId: org.id,
      createdBy: user.id,
    });

    target.environmentName = environmentName;
    target.issuer = issuer;
    target.jwksUrl = jwksUrl;
    target.subjectClaim = subjectClaim;
    target.enabled = input.enabled ?? true;
    target.updatedBy = user.id;
    await target.save();
    return serializeTrustedIssuer(target.toObject());
  }

  async setTrustedIssuerEnabled(user: EnterpriseUserIdentity, trustedIssuerId: string, enabled: boolean) {
    const org = await this.requirePrimaryOrg(user);
    const issuer = await TrustedIssuerModel.findOne({ trustedIssuerId, enterpriseOrgId: org.id });
    if (!issuer) throw new EnterpriseServiceError("not_found", "trusted issuer not found", 404);
    issuer.enabled = enabled;
    issuer.updatedBy = user.id;
    await issuer.save();
    return serializeTrustedIssuer(issuer.toObject());
  }

  /**
   * Fetch a JWKS URL server-side and report whether it is reachable and well
   * formed, so a portal admin can validate an issuer before (or after) saving
   * it. https-only + a short timeout keep this from being a useful SSRF probe.
   */
  async validateJwks(jwksUrl: string): Promise<{
    reachable: boolean;
    keyCount: number;
    algorithms: string[];
    error?: string;
  }> {
    const url = normalizeHttpsUrl(jwksUrl, "JWKS URL");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
      if (!res.ok) return { reachable: false, keyCount: 0, algorithms: [], error: `HTTP ${res.status}` };
      const body = (await res.json()) as { keys?: Array<{ alg?: string }> };
      const keys = Array.isArray(body.keys) ? body.keys : [];
      if (keys.length === 0) {
        return { reachable: true, keyCount: 0, algorithms: [], error: "No keys found in JWKS document" };
      }
      const algorithms = [...new Set(keys.map(key => key.alg).filter((alg): alg is string => Boolean(alg)))];
      return { reachable: true, keyCount: keys.length, algorithms };
    } catch (err) {
      const error = err instanceof Error && err.name === "AbortError" ? "Request timed out" : err instanceof Error ? err.message : "fetch failed";
      return { reachable: false, keyCount: 0, algorithms: [], error };
    } finally {
      clearTimeout(timer);
    }
  }

  private async requirePrimaryOrg(user: EnterpriseUserIdentity) {
    const org = await this.getPrimaryOrgForUser(user);
    if (!org) throw new EnterpriseServiceError("enterprise_org_required", "create an enterprise org first", 428);
    if (org.status === "disabled") throw new EnterpriseServiceError("enterprise_org_disabled", "enterprise org is disabled", 403);
    return org;
  }
}

export class EnterpriseServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "EnterpriseServiceError";
  }
}

// Tenant IDs are a single namespace shared with OEMs and the built-in "mentra"
// tenant. The refresh-time revocation check (assertTenantStillAuthorized in
// session.service) resolves a tenantId against "mentra" -> OEM -> enterprise in
// that order, so an enterprise org must never claim a reserved or OEM tenantId:
// a collision would bind enterprise sessions to the wrong authority or bypass
// revocation entirely.
const RESERVED_TENANT_IDS = new Set(["mentra"]);

async function assertTenantIdAvailable(tenantId: string): Promise<void> {
  if (RESERVED_TENANT_IDS.has(tenantId)) {
    throw new EnterpriseServiceError("tenant_id_reserved", "Tenant ID is reserved", 409);
  }
  const [enterprise, oem] = await Promise.all([
    EnterpriseOrgModel.findOne({ tenantId }).lean(),
    OemModel.findOne({ tenantId }).lean(),
  ]);
  if (enterprise || oem) {
    throw new EnterpriseServiceError("tenant_id_taken", "Tenant ID is already registered", 409);
  }
}

async function uniqueSlug(base: string): Promise<string> {
  let candidate = base;
  let counter = 2;
  while (await EnterpriseOrgModel.findOne({ slug: candidate }).lean()) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  return candidate;
}

function normalizeDisplayName(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < 2) throw new EnterpriseServiceError("invalid_name", "name must be at least 2 characters", 400);
  if (normalized.length > 80) throw new EnterpriseServiceError("invalid_name", "name must be 80 characters or fewer", 400);
  return normalized;
}

function normalizeTenantId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{2,62}$/.test(normalized)) {
    throw new EnterpriseServiceError("invalid_tenant_id", "Tenant ID must be 3-63 lowercase letters, numbers, dashes, or underscores", 400);
  }
  return normalized;
}

function normalizeEnvironmentName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(normalized)) {
    throw new EnterpriseServiceError("invalid_environment", "environment name must be lowercase text like prod or sandbox", 400);
  }
  return normalized;
}

function normalizeHttpsUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new EnterpriseServiceError("invalid_url", `${label} must be a valid URL`, 400);
  }
  if (url.protocol !== "https:") throw new EnterpriseServiceError("invalid_url", `${label} must use https`, 400);
  if (url.search || url.hash) throw new EnterpriseServiceError("invalid_url", `${label} must not include query string or fragment`, 400);
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function normalizeSubjectClaim(value: string | null | undefined): string {
  const normalized = (value || "sub").trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(normalized)) {
    throw new EnterpriseServiceError("invalid_subject_claim", "subject claim must be a JWT claim name", 400);
  }
  return normalized;
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug || `enterprise-${ulid().toLowerCase()}`;
}

function serializeEnterpriseOrg(org: EnterpriseOrg & { createdAt?: Date; updatedAt?: Date }) {
  return {
    id: org.enterpriseOrgId,
    ownerUserId: org.ownerUserId,
    workosOrgId: org.workosOrgId ?? null,
    tenantId: org.tenantId,
    name: org.displayName,
    slug: org.slug,
    status: org.status,
    createdAt: org.createdAt?.toISOString() ?? null,
    updatedAt: org.updatedAt?.toISOString() ?? null,
  };
}

function serializeTrustedIssuer(issuer: TrustedIssuer & { createdAt?: Date; updatedAt?: Date }) {
  return {
    id: issuer.trustedIssuerId,
    enterpriseOrgId: issuer.enterpriseOrgId,
    environmentName: issuer.environmentName,
    issuer: issuer.issuer,
    jwksUrl: issuer.jwksUrl,
    subjectClaim: issuer.subjectClaim,
    enabled: issuer.enabled,
    updatedBy: issuer.updatedBy ?? null,
    createdAt: issuer.createdAt?.toISOString() ?? null,
    updatedAt: issuer.updatedAt?.toISOString() ?? null,
  };
}
