/**
 * @fileoverview Enterprise portal service integration tests.
 *
 * Covers the first real enterprise portal data model: an owner creates an
 * enterprise org, registers trusted issuer environments, and then cannot
 * mutate the org identity in a way that would invalidate issued tokens.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import {
  connectMongo,
  disconnectMongo,
} from "../packages/core/src/connections/mongo.connection";
import { EnterpriseOrgModel } from "../packages/core/src/models/enterprise-org.model";
import { TrustedIssuerModel } from "../packages/core/src/models/trusted-issuer.model";
import { OemModel } from "../packages/core/src/models/oem.model";
import {
  EnterpriseService,
  EnterpriseServiceError,
} from "../packages/core/src/services/enterprise/enterprise.service";

const user = {
  id: "user_enterprise_owner",
  email: "owner@example.com",
};

let enterprise: EnterpriseService;

beforeAll(async () => {
  await connectMongo(
    process.env.MONGO_URL ??
      "mongodb://127.0.0.1:27017/mentra-cloud-v2-test",
  );
  await Promise.all([
    EnterpriseOrgModel.syncIndexes(),
    TrustedIssuerModel.syncIndexes(),
  ]);
  enterprise = new EnterpriseService();
});

afterAll(async () => {
  await disconnectMongo();
});

beforeEach(async () => {
  await Promise.all([
    EnterpriseOrgModel.deleteMany({ ownerUserId: user.id }),
    EnterpriseOrgModel.deleteMany({ tenantId: /^acme/ }),
    TrustedIssuerModel.deleteMany({ issuer: /^https:\/\/auth\.acme\.example/ }),
    OemModel.deleteMany({ tenantId: /^legacy/ }),
  ]);
});

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
