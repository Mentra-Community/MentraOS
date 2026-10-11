/**
 * @fileoverview Enterprise portal integration tests.
 *
 * Covers the enterprise portal data model (an owner creates an enterprise org,
 * registers trusted issuer environments, and cannot mutate the org identity in
 * a way that would invalidate issued tokens) and its API on Core users: orgs
 * are owned by `mentraUserId`, the API takes the enterprise portal session,
 * and refuses Core credentials and the admin portal's cookie.
 *
 * Safety: `localTestMongoUrl` (loopback only, random database, ignores
 * `MONGO_URL`); the database is dropped afterwards.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/enterprise-portal.integration.test.ts`
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { createApp } from "../packages/core/src/api/app";
import {
  connectMongo,
  disconnectMongo,
  mongoReadinessCheck,
} from "../packages/core/src/connections/mongo.connection";
import { BrowserSessionModel } from "../packages/core/src/models/browser-session.model";
import { DeveloperOrgApiKeyModel } from "../packages/core/src/models/developer-org-api-key.model";
import { EnterpriseOrgModel } from "../packages/core/src/models/enterprise-org.model";
import { TrustedIssuerModel } from "../packages/core/src/models/trusted-issuer.model";
import { OemModel } from "../packages/core/src/models/oem.model";
import { DeveloperApiKeyService } from "../packages/core/src/services/developer-orgs/developer-api-key.service";
import {
  EnterpriseService,
  EnterpriseServiceError,
} from "../packages/core/src/services/enterprise/enterprise.service";
import {
  createPortalSession,
  readPortalSession,
} from "../packages/core/src/services/signin/browser-session.service";
import { assertConnectedTo, localTestMongoUrl } from "./support/local-mongo";
import {
  ADMIN_COOKIE,
  applyEnv,
  HOSTED_ENV,
  PORTAL_COOKIE,
  PORTAL_ORIGIN,
} from "./support/signin-harness";

const user = {
  mentraUserId: "mu_enterprise_owner",
  email: "owner@example.com",
};

const databaseUrl = localTestMongoUrl("enterprise-portal");
let verified = false;
let enterprise: EnterpriseService;
let restoreEnv: () => void = () => {};

beforeAll(async () => {
  await connectMongo(databaseUrl);
  assertConnectedTo(databaseUrl, EnterpriseOrgModel.db.name);
  verified = true;
  await Promise.all([
    EnterpriseOrgModel.syncIndexes(),
    TrustedIssuerModel.syncIndexes(),
    BrowserSessionModel.syncIndexes(),
    DeveloperOrgApiKeyModel.syncIndexes(),
  ]);
  enterprise = new EnterpriseService();
});

afterAll(async () => {
  if (verified) {
    assertConnectedTo(databaseUrl, EnterpriseOrgModel.db.name);
    await EnterpriseOrgModel.db.dropDatabase();
  }
  await disconnectMongo();
});

beforeEach(async () => {
  restoreEnv = applyEnv(HOSTED_ENV);
  assertConnectedTo(databaseUrl, EnterpriseOrgModel.db.name);
  await Promise.all([
    EnterpriseOrgModel.deleteMany({}),
    TrustedIssuerModel.deleteMany({}),
    OemModel.deleteMany({}),
    BrowserSessionModel.deleteMany({}),
    DeveloperOrgApiKeyModel.deleteMany({}),
  ]);
});

afterEach(() => restoreEnv());

describe("enterprise portal service", () => {
  test("creates an enterprise org and trusted issuer environments", async () => {
    const org = await enterprise.upsertPrimaryOrg(user, {
      displayName: "Acme Glass",
      tenantId: "acme",
    });
    expect(org.tenantId).toBe("acme");
    expect(org.status).toBe("active");

    const prod = await enterprise.upsertTrustedIssuer(user, {
      environmentName: "Prod",
      issuer: "https://auth.acme.example/prod/",
      jwksUrl: "https://auth.acme.example/prod/.well-known/jwks.json",
      subjectClaim: "sub",
    });
    expect(prod.environmentName).toBe("prod");
    expect(prod.issuer).toBe("https://auth.acme.example/prod");
    expect(prod.enabled).toBe(true);

    const sandbox = await enterprise.upsertTrustedIssuer(user, {
      environmentName: "sandbox",
      issuer: "https://auth.acme.example/sandbox",
      jwksUrl: "https://auth.acme.example/sandbox/.well-known/jwks.json",
      subjectClaim: "user_id",
      enabled: false,
    });
    expect(sandbox.subjectClaim).toBe("user_id");
    expect(sandbox.enabled).toBe(false);

    const disabledProd = await enterprise.setTrustedIssuerEnabled(
      user,
      prod.id,
      false,
    );
    expect(disabledProd.enabled).toBe(false);

    const listed = await enterprise.listTrustedIssuers(user);
    expect(listed.org.id).toBe(org.id);
    expect(listed.issuers.map(issuer => issuer.environmentName)).toEqual([
      "prod",
      "sandbox",
    ]);
  });

  test("locks OEM id after an issuer exists", async () => {
    await enterprise.upsertPrimaryOrg(user, {
      displayName: "Acme Glass",
      tenantId: "acme",
    });
    await enterprise.upsertTrustedIssuer(user, {
      environmentName: "prod",
      issuer: "https://auth.acme.example/prod",
      jwksUrl: "https://auth.acme.example/prod/.well-known/jwks.json",
    });

    await expect(
      enterprise.upsertPrimaryOrg(user, {
        displayName: "Acme Glass",
        tenantId: "acme-renamed",
      }),
    ).rejects.toThrow(EnterpriseServiceError);
  });

  test("rejects the reserved 'mentra' tenant id", async () => {
    await expect(
      enterprise.upsertPrimaryOrg(user, { displayName: "Faux Mentra", tenantId: "mentra" }),
    ).rejects.toMatchObject({ code: "tenant_id_reserved", status: 409 });
  });

  test("rejects a tenant id already registered to an OEM", async () => {
    await OemModel.create({
      tenantId: "legacyoem",
      displayName: "Legacy OEM",
      publicKeyMode: "static",
      publicKey: "test-key",
    });

    await expect(
      enterprise.upsertPrimaryOrg(user, { displayName: "Collider", tenantId: "legacyoem" }),
    ).rejects.toMatchObject({ code: "tenant_id_taken", status: 409 });
  });

  test("allows the same issuer URL across environments", async () => {
    // Lookup keys on the minted (tenantId, env) claims and only pins iss at verify
    // time, so `issuer` is no longer globally unique. One IdP issuer URL must be
    // registrable for multiple environments of the same org.
    await enterprise.upsertPrimaryOrg(user, { displayName: "Acme Glass", tenantId: "acme" });
    const sharedIssuer = "https://auth.acme.example/shared";
    const sharedJwks = "https://auth.acme.example/shared/.well-known/jwks.json";

    const prod = await enterprise.upsertTrustedIssuer(user, {
      environmentName: "prod",
      issuer: sharedIssuer,
      jwksUrl: sharedJwks,
    });
    const sandbox = await enterprise.upsertTrustedIssuer(user, {
      environmentName: "sandbox",
      issuer: sharedIssuer,
      jwksUrl: sharedJwks,
    });

    expect(prod.issuer).toBe(sharedIssuer);
    expect(sandbox.issuer).toBe(sharedIssuer);
    expect(prod.id).not.toBe(sandbox.id);

    const listed = await enterprise.listTrustedIssuers(user);
    expect(listed.issuers.map(issuer => issuer.environmentName)).toEqual(["prod", "sandbox"]);
  });

  test("rejects non-https issuers", async () => {
    await enterprise.upsertPrimaryOrg(user, {
      displayName: "Acme Glass",
      tenantId: "acme",
    });

    await expect(
      enterprise.upsertTrustedIssuer(user, {
        environmentName: "prod",
        issuer: "http://auth.acme.example/prod",
        jwksUrl: "https://auth.acme.example/prod/.well-known/jwks.json",
      }),
    ).rejects.toThrow("issuer must use https");
  });
});

describe("enterprise portal API on Core users", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp({ readinessChecks: [mongoReadinessCheck] });
  });

  async function portalSession(mentraUserId: string, email: string) {
    const { cookieValue } = await createPortalSession("portal", {
      mentraUserId,
      tenantId: "mentra",
      sourceId: "mentra",
      subject: `supa-${mentraUserId}`,
      email,
      emailVerified: true,
      authTime: new Date(),
    });
    return `${PORTAL_COOKIE}=${cookieValue}`;
  }

  function call(path: string, cookie: string, init: { method?: string; body?: unknown } = {}) {
    return app.request(`${PORTAL_ORIGIN}/api/portal${path}`, {
      method: init.method ?? "GET",
      headers: {
        cookie,
        ...(init.body === undefined ? {} : { "content-type": "application/json", origin: PORTAL_ORIGIN }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  }

  test("PUT /org creates an org owned by the signed-in Core user", async () => {
    const owner = await portalSession("mu_1", "owner@acme.example");
    const created = await call("/org", owner, { method: "PUT", body: { displayName: "Acme Glass", tenantId: "acme" } });
    expect(created.status).toBe(200);
    const body = (await created.json()) as { org: { ownerUserId: string; workosOrgId?: unknown } };
    expect(body.org.ownerUserId).toBe("mu_1");
    expect("workosOrgId" in body.org).toBe(false);
    const me = await call("/me", owner);
    expect(((await me.json()) as { user: { id: string } }).user.id).toBe("mu_1");
  });

  test("a second person cannot read or update it", async () => {
    const owner = await portalSession("mu_1", "owner@acme.example");
    await call("/org", owner, { method: "PUT", body: { displayName: "Acme Glass", tenantId: "acme" } });
    const issuer = (await (await call("/trusted-issuers", owner, {
      method: "POST",
      body: { environmentName: "prod", issuer: "https://auth.acme.example/prod", jwksUrl: "https://auth.acme.example/prod/jwks.json" },
    })).json()) as { issuer: { id: string } };

    const other = await portalSession("mu_2", "other@example.com");
    expect(((await (await call("/org", other)).json()) as { org: unknown }).org).toBeNull();
    expect((await call("/trusted-issuers", other)).status).toBe(428);
    const update = await call(`/trusted-issuers/${issuer.issuer.id}`, other, { method: "PATCH", body: { enabled: false } });
    expect(update.status).toBe(428);
    expect((await TrustedIssuerModel.findOne({ trustedIssuerId: issuer.issuer.id }).lean())?.enabled).toBe(true);
  });

  test("trusted-issuer writes record the Core user", async () => {
    const owner = await portalSession("mu_1", "owner@acme.example");
    await call("/org", owner, { method: "PUT", body: { displayName: "Acme Glass", tenantId: "acme" } });
    const created = await call("/trusted-issuers", owner, {
      method: "POST",
      body: { environmentName: "prod", issuer: "https://auth.acme.example/prod", jwksUrl: "https://auth.acme.example/prod/jwks.json" },
    });
    expect(created.status).toBe(201);
    const row = await TrustedIssuerModel.findOne({ environmentName: "prod" }).lean();
    expect(row?.createdBy).toBe("mu_1");
    expect(row?.updatedBy).toBe("mu_1");
  });

  test("a key gets 403 and the admin portal's cookie gets 401", async () => {
    const key = await new DeveloperApiKeyService().create("org_x", "ci", "seed", "local");
    const keyed = await app.request(`${PORTAL_ORIGIN}/api/portal/org`, { headers: { authorization: `Bearer ${key.value}` } });
    expect(keyed.status).toBe(403);
    const { cookieValue } = await createPortalSession("admin", {
      mentraUserId: "mu_1", tenantId: "mentra", sourceId: "mentra", subject: "supa-mu_1",
      email: "owner@acme.example", emailVerified: true, authTime: new Date(),
    });
    expect((await call("/org", `${ADMIN_COOKIE}=${cookieValue}`)).status).toBe(401);
  });

  test("a cross-origin write with the portal cookie gets 403", async () => {
    const owner = await portalSession("mu_1", "owner@acme.example");
    const response = await app.request(`${PORTAL_ORIGIN}/api/portal/org`, {
      method: "PUT",
      headers: { cookie: owner, origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Acme Glass", tenantId: "acme" }),
    });
    expect(response.status).toBe(403);
    expect(await EnterpriseOrgModel.countDocuments({})).toBe(0);
  });

  test("disabling a trusted issuer ends the portal sessions of that sign-in source", async () => {
    await enterprise.upsertPrimaryOrg(user, { displayName: "Acme Glass", tenantId: "acme" });
    const issuer = await enterprise.upsertTrustedIssuer(user, {
      environmentName: "prod",
      issuer: "https://auth.acme.example/prod",
      jwksUrl: "https://auth.acme.example/prod/jwks.json",
    });
    const restore = applyEnv({
      CLOUD_CORE_OIDC_PROVIDERS: JSON.stringify([{
        id: "acme-src", protocol: "oidc", providerKind: "test", tenantId: "acme",
        issuer: "https://auth.acme.example/prod", jwksUrl: "https://auth.acme.example/prod/jwks.json", audience: "core",
      }]),
    });
    try {
      const { cookieValue } = await createPortalSession("admin", {
        mentraUserId: "mu_acme", tenantId: "acme", sourceId: "acme-src", subject: "acme-1",
        email: null, emailVerified: false, authTime: new Date(),
      });
      expect(await readPortalSession("admin", cookieValue)).not.toBeNull();
      await enterprise.setTrustedIssuerEnabled(user, issuer.id, false);
      expect(await readPortalSession("admin", cookieValue)).toBeNull();
    } finally {
      restore();
    }
  });
});
