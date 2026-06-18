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
    EnterpriseOrgModel.deleteMany({ oemId: /^acme/ }),
    TrustedIssuerModel.deleteMany({ issuer: /^https:\/\/auth\.acme\.example/ }),
  ]);
});

describe("enterprise portal service", () => {
  test("creates an enterprise org and trusted issuer environments", async () => {
    const org = await enterprise.upsertPrimaryOrg(user, {
      displayName: "Acme Glass",
      oemId: "acme",
    });
    expect(org.oemId).toBe("acme");
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
      oemId: "acme",
    });
    await enterprise.upsertTrustedIssuer(user, {
      environmentName: "prod",
      issuer: "https://auth.acme.example/prod",
      jwksUrl: "https://auth.acme.example/prod/.well-known/jwks.json",
    });

    await expect(
      enterprise.upsertPrimaryOrg(user, {
        displayName: "Acme Glass",
        oemId: "acme-renamed",
      }),
    ).rejects.toThrow(EnterpriseServiceError);
  });

  test("rejects non-https issuers", async () => {
    await enterprise.upsertPrimaryOrg(user, {
      displayName: "Acme Glass",
      oemId: "acme",
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
