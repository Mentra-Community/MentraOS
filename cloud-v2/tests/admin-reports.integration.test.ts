/**
 * @fileoverview Admin report triage API integration tests.
 *
 * Covers the read surface behind the internal admin console, gated by the
 * `organization.incidents.read` capability: list (filters, context excluded),
 * detail (context + asset rows), artifact payload bytes, and the gate itself
 * (401 without credentials, 403 for a principal without the capability). An
 * Organization Admin reaches it with a WorkOS token, and an operator key
 * (`mak_`, minted here through `createOperatorKey`) with its scope.
 *
 * WorkOS authentication is stubbed at the identity-provider boundary. Core's
 * real admin allowlist, principal resolution, credentials, report APIs,
 * storage and database are exercised.
 *
 * Prereq: a running Mongo replica set (operator keys are created in a
 * transaction). Defaults to `mongodb://127.0.0.1:27017/mentra-cloud-v2-test`;
 * override via `MONGO_URL`. The test wipes its own collections between cases —
 * do NOT point at a real DB.
 *
 * Run: `bun test tests/admin-reports.integration.test.ts`
 */

import crypto from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test, spyOn } from "bun:test";

const STORAGE_DIR = join(tmpdir(), `mentra-admin-reports-test-${process.pid}`);
const savedAdminEmails = process.env.CLOUD_CORE_ADMIN_EMAILS;
const savedAdminDomains = process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS;
const savedServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
let directoryUsers: Array<{ id: string; email: string }> = [];
let directoryFailure = false;
let directoryNeverEnds = false;
let directoryRequests = 0;
// A local directory deliberately ignores filter, like older GoTrue deployments.
// This verifies that the server still applies exact admin matching itself.
const directory = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(req) {
    directoryRequests++;
    const url = new URL(req.url);
    if (url.pathname !== "/auth/v1/admin/users") return new Response(null, { status: 404 });
    if (directoryFailure) return new Response(null, { status: 503 });
    const page = Number(url.searchParams.get("page"));
    const perPage = Number(url.searchParams.get("per_page"));
    return Response.json({ users: directoryNeverEnds
      ? Array.from({ length: perPage }, (_, i) => ({ id: `repeated-${i}`, email: "outside@example.test" }))
      : directoryUsers.slice((page - 1) * perPage, page * perPage) });
  },
});
{
  const { privateKey: nodePriv, publicKey: nodePub } =
    crypto.generateKeyPairSync("ed25519");
  process.env.MENTRA_JWT_PRIVATE_KEY = stripPemWrap(
    nodePriv.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  process.env.MENTRA_JWT_PUBLIC_KEY = stripPemWrap(
    nodePub.export({ type: "spki", format: "pem" }).toString(),
  );
  process.env.REFRESH_TOKEN_PEPPER ??= "test-pepper-not-for-production";
  process.env.MONGO_URL ??= "mongodb://127.0.0.1:27017/mentra-cloud-v2-test";
  process.env.SUPABASE_JWT_SECRET = "test-supabase-secret-not-for-production";
  process.env.SUPABASE_URL = directory.url.origin;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "local-directory-test-key";
  process.env.CLOUD_CORE_LOCAL_STORAGE_DIR = STORAGE_DIR;
  // Pin the environment label for deterministic local requests.
  process.env.CLOUD_CORE_ENVIRONMENT = "local";
  process.env.WORKOS_API_KEY = "test-workos-service-secret";
  process.env.WORKOS_CLIENT_ID = "client_test";
  process.env.WORKOS_COOKIE_PASSWORD = "test-cookie-password-with-at-least-32-characters";
}

// eslint-disable-next-line import/first
import {
  connectMongo,
  disconnectMongo,
  mongoReadinessCheck,
} from "../packages/core/src/connections/mongo.connection";
import { createApp } from "../packages/core/src/api/app";
import * as developerAuth from "../packages/developer-auth/src/index";
import { ReportModel } from "../packages/core/src/models/report.model";
import { ReportAssetModel } from "../packages/core/src/models/report-asset.model";
import { UserModel } from "../packages/core/src/models/user.model";
import { AccessCredentialModel } from "../packages/core/src/models/access-credential.model";
import { IdentityLinkModel } from "../packages/core/src/models/identity-link.model";
import { WorkspaceAuditCounterModel } from "../packages/core/src/models/workspace-audit-counter.model";
import { WorkspaceAuditEventModel } from "../packages/core/src/models/workspace-audit-event.model";
import { createOperatorKey } from "../packages/core/src/services/workspaces/credential.service";
import { resolveWorkosUser } from "../packages/core/src/services/workspaces/identity-link.service";
import { RefreshTokenModel } from "../packages/core/src/models/refresh-token.model";
import { SeenJtiModel } from "../packages/core/src/models/seen-jti.model";
import { RevokedJtiModel } from "../packages/core/src/models/revoked-jti.model";

const REPORTS_PATH = "http://localhost/api/client/reports";
const ADMIN_REPORTS_PATH = "http://localhost/api/admin/reports";

let coreApp: ReturnType<typeof createApp>;
let userAccessToken: string;
const adminEmail = "admin@example.com";
const adminBearer = "test-workos-admin-token";
const nonAdminBearer = "test-workos-developer-token";
// Same allowlisted address as the admin, but WorkOS has not verified the email.
const unverifiedAdminBearer = "test-workos-unverified-admin-token";
let authSpy: ReturnType<typeof spyOn>;
// Operator keys (`mak_`) minted by an allowlisted, verified Organization Admin.
let incidentsKey: { token: string; credentialId: string };
let testingKey: { token: string; credentialId: string };
const WORKOS_USER_PREFIX = "admin-reports-workos-";

beforeAll(async () => {
  await connectMongo(process.env.MONGO_URL!);
  await Promise.all([
    ReportModel.syncIndexes(),
    ReportAssetModel.syncIndexes(),
    UserModel.syncIndexes(),
    RefreshTokenModel.syncIndexes(),
    SeenJtiModel.syncIndexes(),
    RevokedJtiModel.syncIndexes(),
    AccessCredentialModel.init(),
    IdentityLinkModel.init(),
    WorkspaceAuditCounterModel.init(),
    WorkspaceAuditEventModel.init(),
  ]);
  coreApp = createApp({ readinessChecks: [mongoReadinessCheck] });
  authSpy = spyOn(developerAuth, "authenticateWorkosRequest").mockImplementation(async c => {
    const token = c.req.header("authorization");
    const bearers = [adminBearer, nonAdminBearer, unverifiedAdminBearer].map(bearer => `Bearer ${bearer}`);
    if (!token || !bearers.includes(token)) {
      return {authenticated: false, reason: "invalid_token"};
    }
    return {
      authenticated: true,
      user: {
        id: `${WORKOS_USER_PREFIX}${token.slice("Bearer ".length)}`,
        email: token === `Bearer ${nonAdminBearer}` ? "developer@example.com" : "admin@example.com",
        emailVerified: token !== `Bearer ${unverifiedAdminBearer}`,
      },
      organizationId: null,
      accessToken: token.slice("Bearer ".length),
    };
  });

  const exchanged = await exchange(mintSupabaseJwt("admin-reports-user-1"));
  expect(exchanged.status).toBe(200);
  userAccessToken = ((await exchanged.json()) as { access_token: string }).access_token;

  process.env.CLOUD_CORE_ADMIN_EMAILS = "admin@example.com";

  // Link the stubbed WorkOS people up front, while the directory is healthy: a first sign-in
  // consults it, and later cases switch it off on purpose.
  const admin = await resolveWorkosUser({
    workosUserId: `${WORKOS_USER_PREFIX}${adminBearer}`, email: adminEmail, emailVerified: true, name: null,
  });
  for (const [bearer, email, emailVerified] of [
    [nonAdminBearer, "developer@example.com", true],
    [unverifiedAdminBearer, adminEmail, false],
  ] as const) {
    await resolveWorkosUser({ workosUserId: `${WORKOS_USER_PREFIX}${bearer}`, email, emailVerified, name: null });
  }
  const actor = {
    kind: "user" as const, mentraUserId: admin.mentraUserId, email: adminEmail, emailVerified: true, name: null,
    isOrganizationAdmin: true,
  };
  const mint = async (name: string, scope: "organization.incidents.read" | "organization.testing.read") => {
    const created = await createOperatorKey(actor, { name, scopes: [scope] });
    return { token: created.token, credentialId: created.credential.credentialId };
  };
  incidentsKey = await mint("admin-reports incidents", "organization.incidents.read");
  testingKey = await mint("admin-reports testing", "organization.testing.read");
});

afterAll(async () => {
  if (savedAdminEmails === undefined) delete process.env.CLOUD_CORE_ADMIN_EMAILS;
  else process.env.CLOUD_CORE_ADMIN_EMAILS = savedAdminEmails;
  authSpy?.mockRestore();
  if (savedAdminDomains === undefined) delete process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS;
  else process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS = savedAdminDomains;
  if (savedServiceKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = savedServiceKey;
  directory.stop(true);
  await AccessCredentialModel.deleteMany({ credentialId: { $in: [incidentsKey?.credentialId, testingKey?.credentialId].filter(Boolean) } });
  await IdentityLinkModel.deleteMany({ subject: { $regex: `^${WORKOS_USER_PREFIX}` } });
  await UserModel.deleteMany({ tenantId: "workos", tenantUserId: { $regex: `^${WORKOS_USER_PREFIX}` } });
  await UserModel.deleteMany({ tenantUserId: /^internal-fixture-/ });
  await disconnectMongo();
  await rm(STORAGE_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  process.env.CLOUD_CORE_ADMIN_EMAILS = adminEmail;
  process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS = "";
  directoryUsers = [];
  directoryFailure = false;
  directoryNeverEnds = false;
  directoryRequests = 0;
  await Promise.all([
    ReportModel.deleteMany({}),
    ReportAssetModel.deleteMany({}),
    UserModel.deleteMany({ tenantUserId: /^internal-fixture-/ }),
  ]);
});

describe("admin reports auth gate", () => {
  test("rejects requests without credentials and non-admin principals", async () => {
    const anonymous = await coreApp.fetch(new Request(ADMIN_REPORTS_PATH));
    expect(anonymous.status).toBe(401);

    const forbidden = await coreApp.fetch(
      new Request(ADMIN_REPORTS_PATH, { headers: { authorization: `Bearer ${nonAdminBearer}` } }),
    );
    expect(forbidden.status).toBe(403);

    // An allowlisted address only counts once the identity provider verified it.
    const unverified = await coreApp.fetch(
      new Request(ADMIN_REPORTS_PATH, { headers: { authorization: `Bearer ${unverifiedAdminBearer}` } }),
    );
    expect(unverified.status).toBe(403);
  });
});

describe("admin reports with an operator key", () => {
  test("a key holding organization.incidents.read reads the list, detail and artifact bytes", async () => {
    const screenshot = crypto.randomBytes(900);
    const reportId = await seedReport("operator key crash", screenshot);

    const list = await keyGet(ADMIN_REPORTS_PATH, incidentsKey.token);
    expect(list.status).toBe(200);
    const { reports } = (await list.json()) as { reports: Array<{ reportId: string }> };
    expect(reports.map(r => r.reportId)).toEqual([reportId]);

    const detail = await keyGet(`${ADMIN_REPORTS_PATH}/${reportId}`, incidentsKey.token);
    expect(detail.status).toBe(200);
    const { report } = (await detail.json()) as { report: { artifacts: Array<{ artifactId: string; type: string }> } };
    const shot = report.artifacts.find(a => a.type === "screenshot")!;

    const url = `${ADMIN_REPORTS_PATH}/${reportId}/artifacts/${shot.artifactId}`;
    const bytes = await keyGet(url, incidentsKey.token);
    expect(bytes.status).toBe(200);
    expect(Buffer.from(await bytes.arrayBuffer()).equals(screenshot)).toBe(true);
    const ranged = await coreApp.fetch(new Request(url, { headers: { authorization: `Bearer ${incidentsKey.token}`, range: "bytes=0-3" } }));
    expect(ranged.status).toBe(206);
    expect(Buffer.from(await ranged.arrayBuffer()).equals(screenshot.subarray(0, 4))).toBe(true);
    const head = await coreApp.fetch(new Request(url, { method: "HEAD", headers: { authorization: `Bearer ${incidentsKey.token}` } }));
    expect(head.status).toBe(200);
  });

  test("a key without the scope, or with only another one, is refused on every report route", async () => {
    const reportId = await seedReport("scoped crash");
    const detail = await keyGet(`${ADMIN_REPORTS_PATH}/${reportId}`, incidentsKey.token);
    const { report } = (await detail.json()) as { report: { artifacts: Array<{ artifactId: string }> } };

    for (const path of [ADMIN_REPORTS_PATH, `${ADMIN_REPORTS_PATH}/${reportId}`, `${ADMIN_REPORTS_PATH}/${reportId}/artifacts/${report.artifacts[0].artifactId}`]) {
      const refused = await keyGet(path, testingKey.token);
      expect([path, refused.status]).toEqual([path, 403]);
      expect(await refused.json()).toEqual({ error: "forbidden" });
    }
  });

  test("the incidents key cannot write test dispatches, and stops working once its creator is no longer an admin", async () => {
    const dispatch = await coreApp.fetch(new Request("http://localhost/api/admin/test-dispatches", {
      method: "POST",
      headers: { authorization: `Bearer ${incidentsKey.token}`, "content-type": "application/json" },
      body: "{}",
    }));
    expect(dispatch.status).toBe(403);

    expect((await keyGet(ADMIN_REPORTS_PATH, incidentsKey.token)).status).toBe(200);
    process.env.CLOUD_CORE_ADMIN_EMAILS = "someone-else@example.com";
    expect((await keyGet(ADMIN_REPORTS_PATH, incidentsKey.token)).status).toBe(401);
  });

  test("the key is not a WorkOS credential: a tampered secret is 401", async () => {
    expect((await keyGet(ADMIN_REPORTS_PATH, `${incidentsKey.token}x`)).status).toBe(401);
    expect((await keyGet(ADMIN_REPORTS_PATH, "mak_local_notakey")).status).toBe(401);
  });
});

describe("admin reports read surface", () => {
  test("separates harness reports by their existing source without changing stored kinds", async () => {
    process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS = "company.test";
    directoryUsers = [{ id: "internal-fixture-harness", email: "admin@company.test" }];
    await UserModel.create({ mentraUserId: "mu_harness_admin", tenantId: "mentra", tenantUserId: "internal-fixture-harness" });
    const fixtures = [
      { reportId: "rep_harness_old", kind: "automatic", source: "mentra_automated_testing", status: "ready", mentraUserId: "mu_harness_admin" },
      { reportId: "rep_harness_bug", kind: "bug", source: "mentra_automated_testing", status: "closed", mentraUserId: "mu_harness_admin" },
      { reportId: "rep_harness_new", kind: "automatic", source: "mentra_automated_testing", status: "ready", mentraUserId: "mu_harness_customer" },
      { reportId: "rep_runtime", kind: "automatic", source: "runtime", status: "ready", mentraUserId: "mu_harness_admin" },
      { reportId: "rep_untagged", kind: "automatic", source: undefined, status: "ready", mentraUserId: "mu_harness_customer" },
      { reportId: "rep_human", kind: "bug", source: "feedback_screen", status: "ready", mentraUserId: "mu_harness_admin" },
    ];
    for (const [i, fixture] of fixtures.entries()) {
      const { source, ...row } = fixture;
      await ReportModel.create({ ...row, trigger: source ? { type: row.kind === "bug" ? "manual" : "automatic", source, reason: "test" } : null,
        context: { source: "mentra_automated_testing" }, createdAt: new Date(1_700_000_000_000 + i * 1000) });
    }
    const testing = await listed("kind=testing");
    expect(testing.map(row => row.reportId)).toEqual(["rep_harness_new", "rep_harness_bug", "rep_harness_old"]);
    expect(testing.map(row => row.kind)).toEqual(["automatic", "bug", "automatic"]);
    expect((await listed("kind=automatic")).map(row => row.reportId)).toEqual(["rep_untagged", "rep_runtime"]);
    expect((await listed("kind=internal")).map(row => row.reportId)).toEqual(["rep_human"]);
    expect(await listed("kind=bug")).toEqual([]);
    expect((await listed("kind=testing&status=ready&limit=1")).map(row => row.reportId)).toEqual(["rep_harness_new"]);
    expect((await listed("kind=testing&before=2023-11-14T22:13:21.500Z&limit=1")).map(row => row.reportId)).toEqual(["rep_harness_bug"]);
    expect(await listed("")).toHaveLength(fixtures.length);
    directoryFailure = true;
    directoryRequests = 0;
    expect(await listed("kind=testing")).toHaveLength(3);
    expect(await listed("kind=automatic")).toHaveLength(2);
    expect(directoryRequests).toBe(0);
  });

  test("separates historical human admin submissions while keeping automatic reports together", async () => {
    const fixtures = [
      { id: "internal-fixture-named", email: "NAMED@personal.test", internal: true },
      { id: "internal-fixture-domain", email: "user@company.test", internal: true },
      { id: "internal-fixture-second", email: "user@second.test", internal: true },
      { id: "internal-fixture-outsider", email: "user@personal.test", internal: false },
      { id: "internal-fixture-subdomain", email: "user@sub.company.test", internal: false },
      { id: "internal-fixture-suffix", email: "user@company.test.evil.test", internal: false },
    ];
    directoryUsers = fixtures;
    const internalIds: string[] = [];
    const externalIds: string[] = [];
    for (const [index, fixture] of fixtures.entries()) {
      await UserModel.create({ mentraUserId: `mu_${fixture.id}`, tenantId: "mentra", tenantUserId: fixture.id });
      for (const kind of ["bug", "feedback", "automatic"]) {
        const reportId = `rep_${fixture.id}-${kind}`;
        (fixture.internal ? internalIds : externalIds).push(reportId);
        await ReportModel.create({
          reportId, mentraUserId: `mu_${fixture.id}`, kind, status: "ready",
          // Deliberately misleading client-provided email must not make this internal.
          report: { actualBehavior: "fixture", contactEmail: "user@company.test" },
          context: { email: "user@company.test" }, createdAt: new Date(1_700_000_000_000 + index * 1000),
        });
      }
    }
    // OEM identity collides with an admin's GoTrue subject; it stays external.
    await UserModel.create({ mentraUserId: "mu_oem", tenantId: "other-oem", tenantUserId: fixtures[0].id });
    await ReportModel.create({ reportId: "rep_oem", mentraUserId: "mu_oem", kind: "bug", status: "closed", context: {} });
    // Change the allowlists AFTER all reports exist: no migration/re-submission required.
    process.env.CLOUD_CORE_ADMIN_EMAILS = `${adminEmail}, named@personal.test`;
    process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS = "company.test, @SECOND.test";

    const internal = await listed("kind=internal");
    expect(internal.map(row => row.reportId).sort()).toEqual(internalIds.filter(id => !id.endsWith("-automatic")).sort());
    expect(new Set(internal.map(row => row.kind))).toEqual(new Set(["bug", "feedback"]));
    for (const kind of ["bug", "feedback"]) {
      const rows = await listed(`kind=${kind}&status=ready`);
      expect(rows.map(row => row.reportId).sort()).toEqual(externalIds.filter(id => id.endsWith(`-${kind}`)).sort());
    }
    expect((await listed("kind=automatic&status=ready")).map(row => row.reportId).sort()).toEqual(
      [...internalIds, ...externalIds].filter(id => id.endsWith("-automatic")).sort(),
    );
    expect((await listed("kind=bug&status=closed")).map(row => row.reportId)).toEqual(["rep_oem"]);
    expect(await listed("kind=internal&status=closed")).toEqual([]);
    const limited = await listed("kind=internal&limit=2&before=2023-11-14T22:13:21.500Z");
    expect(limited).toHaveLength(2);
    expect(limited.every(row => row.mentraUserId === "mu_internal-fixture-domain")).toBe(true);
    directoryRequests = 0;
    expect(await listed("")).toHaveLength(19);
    expect(directoryRequests).toBe(0);
    process.env.CLOUD_CORE_ADMIN_EMAILS = adminEmail;
    process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS = "";
    expect(await listed("kind=internal")).toEqual([]);
    expect(await listed("kind=bug")).toHaveLength(7);
  });

  test("finds admins beyond the first directory page and rejects incomplete classification", async () => {
    directoryUsers = Array.from({ length: 200 }, (_, i) => ({ id: `outside-${i}`, email: `outside-${i}@example.test` }));
    directoryUsers.push({ id: "internal-fixture-late", email: "late@company.test" });
    await UserModel.create({ mentraUserId: "mu_late", tenantId: "mentra", tenantUserId: "internal-fixture-late" });
    await ReportModel.create({ reportId: "rep_late", mentraUserId: "mu_late", kind: "bug", context: {} });
    process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS = "company.test";
    expect((await listed("kind=internal")).map(row => row.reportId)).toEqual(["rep_late"]);
    directoryFailure = true;
    expect((await adminGet(`${ADMIN_REPORTS_PATH}?kind=internal`)).status).toBe(502);
    expect((await adminGet(`${ADMIN_REPORTS_PATH}?kind=bug`)).status).toBe(502);
    // The unfiltered incident evidence remains usable during a directory outage.
    expect(await listed("")).toHaveLength(1);
    expect(await listed("kind=automatic")).toEqual([]);
    expect((await adminGet(`${ADMIN_REPORTS_PATH}/rep_late`)).status).toBe(200);
    directoryFailure = false;
    directoryNeverEnds = true;
    expect((await adminGet(`${ADMIN_REPORTS_PATH}?kind=internal`)).status).toBe(502);
  });

  test("lists reports newest-first with artifact metadata and no context", async () => {
    const first = await seedReport("first crash");
    const second = await seedReport("second crash");

    const res = await adminGet(ADMIN_REPORTS_PATH);
    expect(res.status).toBe(200);
    const { reports } = (await res.json()) as { reports: Array<Record<string, unknown>> };
    const ids = reports.map(r => r.reportId);
    expect(ids.indexOf(second)).toBeLessThan(ids.indexOf(first));

    const row = reports.find(r => r.reportId === first)!;
    expect(row.kind).toBe("bug");
    expect(row.mentraUserId).toMatch(/^mu_/);
    expect("context" in row).toBe(false);
    const artifacts = row.artifacts as Array<Record<string, unknown>>;
    expect(artifacts).toHaveLength(2);
    expect(artifacts.map(a => a.type).sort()).toEqual(["logs", "screenshot"]);

    const filtered = await adminGet(`${ADMIN_REPORTS_PATH}?kind=feedback`);
    expect(((await filtered.json()) as { reports: unknown[] }).reports).toHaveLength(0);

    const badQuery = await adminGet(`${ADMIN_REPORTS_PATH}?kind=nonsense`);
    expect(badQuery.status).toBe(400);
  });

  test("returns full detail with context and asset rows", async () => {
    const reportId = await seedReport("detail crash");

    const res = await adminGet(`${ADMIN_REPORTS_PATH}/${reportId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      report: Record<string, unknown>;
      assets: Array<Record<string, unknown>>;
    };
    expect(body.report.reportId).toBe(reportId);
    expect(body.report.context).toEqual({ app: { appVersion: "test" } });
    expect(body.assets).toHaveLength(2);
    for (const asset of body.assets) {
      expect(typeof asset.storageKey).toBe("string");
      expect(typeof asset.sha256).toBe("string");
    }

    const missing = await adminGet(`${ADMIN_REPORTS_PATH}/rep_nope`);
    expect(missing.status).toBe(404);
  });

  test("serves artifact payload bytes with the stored content type", async () => {
    const screenshot = crypto.randomBytes(1536);
    const reportId = await seedReport("artifact crash", screenshot);

    const detail = await adminGet(`${ADMIN_REPORTS_PATH}/${reportId}`);
    const { report } = (await detail.json()) as {
      report: { artifacts: Array<{ artifactId: string; type: string }> };
    };
    const shot = report.artifacts.find(a => a.type === "screenshot")!;
    const logs = report.artifacts.find(a => a.type === "logs")!;

    const shotRes = await adminGet(`${ADMIN_REPORTS_PATH}/${reportId}/artifacts/${shot.artifactId}`);
    expect(shotRes.status).toBe(200);
    expect(shotRes.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await shotRes.arrayBuffer()).equals(screenshot)).toBe(true);

    const logsRes = await adminGet(`${ADMIN_REPORTS_PATH}/${reportId}/artifacts/${logs.artifactId}`);
    expect(logsRes.status).toBe(200);
    expect(logsRes.headers.get("content-type")).toBe("application/json");
    const parsed = (await logsRes.json()) as { entries: Array<{ message: string }> };
    expect(parsed.entries[0].message).toBe("glasses connected");

    const missing = await adminGet(`${ADMIN_REPORTS_PATH}/${reportId}/artifacts/art_nope`);
    expect(missing.status).toBe(404);
  });

  test("serves genuine images inline with hardening headers", async () => {
    const reportId = await seedReport("inline headers");
    const detail = await adminGet(`${ADMIN_REPORTS_PATH}/${reportId}`);
    const { report } = (await detail.json()) as {
      report: { artifacts: Array<{ artifactId: string; type: string }> };
    };
    const shot = report.artifacts.find(a => a.type === "screenshot")!;

    const res = await adminGet(`${ADMIN_REPORTS_PATH}/${reportId}/artifacts/${shot.artifactId}`);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("content-disposition")).toStartWith("inline;");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  test("lists a host video and plays it inline for admins only, with its exact type and length", async () => {
    const reportId = await seedReport("video attached");
    // Genuine synthetic silent H264 MP4 (see tests/fixtures); playback itself is
    // qualified in a browser, not here.
    const video = await readFile(new URL("./fixtures/synthetic-silent-h264-64x64-10f.mp4", import.meta.url));
    const form = new FormData();
    form.append("type", "video");
    form.append("source", "host");
    form.append("files", new File([video], "recording.mp4", { type: "video/mp4" }));
    const upload = await coreApp.fetch(
      new Request(`${REPORTS_PATH}/${reportId}/artifacts`, {
        method: "POST",
        headers: { authorization: `Bearer ${userAccessToken}` },
        body: form,
      }),
    );
    expect(upload.status).toBe(200);

    const list = await adminGet(ADMIN_REPORTS_PATH);
    const listed = ((await list.json()) as { reports: Array<{ reportId: string; artifacts: Array<{ type: string }> }> })
      .reports.find(r => r.reportId === reportId)!;
    expect(listed.artifacts.map(a => a.type).sort()).toEqual(["logs", "screenshot", "video"]);

    const detail = await adminGet(`${ADMIN_REPORTS_PATH}/${reportId}`);
    const { report, assets } = (await detail.json()) as {
      report: { artifacts: Array<{ artifactId: string; type: string; source: string; filename: string; contentType: string; sizeBytes: number }> };
      assets: Array<{ artifactId: string; contentType: string; sizeBytes: number; sha256: string }>;
    };
    const clip = report.artifacts.find(a => a.type === "video")!;
    expect(clip).toMatchObject({ source: "host", filename: "recording.mp4", contentType: "video/mp4", sizeBytes: video.byteLength });
    const asset = assets.find(a => a.artifactId === clip.artifactId)!;
    expect(asset).toMatchObject({ contentType: "video/mp4", sizeBytes: video.byteLength });
    expect(asset.sha256).toBe(crypto.createHash("sha256").update(video).digest("hex"));
    const url = `${ADMIN_REPORTS_PATH}/${reportId}/artifacts/${clip.artifactId}`;

    const res = await adminGet(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("content-length")).toBe(String(video.byteLength));
    expect(res.headers.get("content-disposition")).toBe('inline; filename="recording.mp4"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
    expect(Buffer.from(await res.arrayBuffer()).equals(video)).toBe(true);

    expect((await coreApp.fetch(new Request(url))).status).toBe(401);
    const forbidden = await coreApp.fetch(
      new Request(url, { headers: { authorization: `Bearer ${nonAdminBearer}` } }),
    );
    expect(forbidden.status).toBe(403);
  });

  test("serves incident video byte ranges over a real socket to admins only, with exact lengths and security headers", async () => {
    const reportId = await seedReport("ranged video");
    const video = await readFile(new URL("./fixtures/synthetic-silent-h264-64x64-10f.mp4", import.meta.url));
    const size = video.byteLength;
    const form = new FormData();
    form.append("type", "video");
    form.append("source", "host");
    form.append("files", new File([video], "recording.mp4", { type: "video/mp4" }));
    const upload = await coreApp.fetch(
      new Request(`${REPORTS_PATH}/${reportId}/artifacts`, {
        method: "POST",
        headers: { authorization: `Bearer ${userAccessToken}` },
        body: form,
      }),
    );
    expect(upload.status).toBe(200);
    const detailBefore = await (await adminGet(`${ADMIN_REPORTS_PATH}/${reportId}`)).json() as {
      report: { artifacts: Array<{ artifactId: string; type: string }> };
      assets: Array<{ artifactId: string; sha256: string }>;
    };
    const clip = detailBefore.report.artifacts.find(a => a.type === "video")!;
    const sha256 = detailBefore.assets.find(a => a.artifactId === clip.artifactId)!.sha256;

    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => coreApp.fetch(request) });
    try {
      const url = new URL(`/api/admin/reports/${reportId}/artifacts/${clip.artifactId}`, server.url);
      const admin = { authorization: `Bearer ${adminBearer}` };
      const expectMediaHeaders = (res: Response) => {
        expect(res.headers.get("content-type")).toBe("video/mp4");
        expect(res.headers.get("content-disposition")).toBe('inline; filename="recording.mp4"');
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
        expect(res.headers.get("cache-control")).toBe("private, max-age=300");
        expect(res.headers.get("accept-ranges")).toBe("bytes");
        expect(res.headers.get("etag")).toBe(`"${sha256}"`);
      };

      // Media players probe the start, then read the tail and seek.
      for (const [range, start, end] of [
        ["bytes=0-1", 0, 1],
        ["bytes=-1024", size - 1024, size - 1],
        ["bytes=100-", 100, size - 1],
        ["bytes=4-7", 4, 7],
      ] as const) {
        const res = await fetch(url, { headers: { ...admin, range } });
        expect(res.status).toBe(206);
        expect(res.headers.get("content-length")).toBe(String(end - start + 1));
        expect(res.headers.get("content-range")).toBe(`bytes ${start}-${end}/${size}`);
        expect(res.headers.get("transfer-encoding")).toBeNull();
        expectMediaHeaders(res);
        expect(Buffer.from(await res.arrayBuffer()).equals(video.subarray(start, end + 1))).toBe(true);
      }

      const full = await fetch(url, { headers: admin });
      expect(full.status).toBe(200);
      expect(full.headers.get("content-length")).toBe(String(size));
      expectMediaHeaders(full);
      expect(Buffer.from(await full.arrayBuffer()).equals(video)).toBe(true);

      const headRange = await fetch(url, { method: "HEAD", headers: { ...admin, range: "bytes=0-1" } });
      expect(headRange.status).toBe(206);
      expect(headRange.headers.get("content-length")).toBe("2");
      expect((await headRange.arrayBuffer()).byteLength).toBe(0);
      const head = await fetch(url, { method: "HEAD", headers: admin });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe(String(size));
      expect((await head.arrayBuffer()).byteLength).toBe(0);

      const current = await fetch(url, { headers: { ...admin, range: "bytes=0-1", "if-range": `"${sha256}"` } });
      expect(current.status).toBe(206);
      await current.arrayBuffer();
      const changed = await fetch(url, { headers: { ...admin, range: "bytes=0-1", "if-range": '"old"' } });
      expect(changed.status).toBe(200);
      expect(Buffer.from(await changed.arrayBuffer()).equals(video)).toBe(true);

      for (const range of ["bytes=0-1,4-5", `bytes=${size}-`, "bytes=9-3"]) {
        const res = await fetch(url, { headers: { ...admin, range } });
        expect(res.status).toBe(416);
        expect(res.headers.get("content-range")).toBe(`bytes */${size}`);
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        await res.arrayBuffer();
      }

      // Ranges and HEAD do not bypass the admin gate.
      for (const method of ["GET", "HEAD"]) {
        const anonymous = await fetch(url, { method, headers: { range: "bytes=0-1" } });
        expect(anonymous.status).toBe(401);
        expect(anonymous.headers.get("content-range")).toBeNull();
        await anonymous.arrayBuffer();
        const forbidden = await fetch(url, { method, headers: { authorization: `Bearer ${nonAdminBearer}`, range: "bytes=0-1" } });
        expect(forbidden.status).toBe(403);
        expect(forbidden.headers.get("content-range")).toBeNull();
        await forbidden.arrayBuffer();
      }
    } finally {
      await server.stop(true);
    }

    // Range reads leave the report metadata untouched.
    const detailAfter = await (await adminGet(`${ADMIN_REPORTS_PATH}/${reportId}`)).json();
    expect(detailAfter).toEqual(detailBefore);
  });

  test("a ranged read of an opaque artifact stays a nosniff attachment", async () => {
    const reportId = await seedReport("ranged opaque");
    const form = new FormData();
    form.append("files", new File(["<script>document.title='pwned'</script>"], "evil.html", { type: "text/html" }));
    const upload = await coreApp.fetch(
      new Request(`${REPORTS_PATH}/${reportId}/artifacts`, {
        method: "POST",
        headers: { authorization: `Bearer ${userAccessToken}` },
        body: form,
      }),
    );
    expect(upload.status).toBe(200);
    const detail = await adminGet(`${ADMIN_REPORTS_PATH}/${reportId}`);
    const { report } = (await detail.json()) as {
      report: { artifacts: Array<{ artifactId: string; filename: string | null }> };
    };
    const hostile = report.artifacts.find(a => a.filename === "evil.html")!;

    const res = await coreApp.fetch(new Request(`${ADMIN_REPORTS_PATH}/${reportId}/artifacts/${hostile.artifactId}`, {
      headers: { authorization: `Bearer ${adminBearer}`, range: "bytes=0-7" },
    }));
    expect(res.status).toBe(206);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toStartWith("attachment;");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(await res.text()).toBe("<script>");
  });

  test("never renders a spoofed screenshot content type inline", async () => {
    const reportId = await seedReport("hostile upload");

    // A reporter attaches HTML bytes claiming to be a screenshot. The upload
    // path must not store the scriptable type, and the admin artifact route
    // must serve it as an opaque download rather than same-origin HTML.
    const form = new FormData();
    form.append(
      "files",
      new File(["<script>document.title='pwned'</script>"], "evil.html", { type: "text/html" }),
    );
    const upload = await coreApp.fetch(
      new Request(`${REPORTS_PATH}/${reportId}/artifacts`, {
        method: "POST",
        headers: { authorization: `Bearer ${userAccessToken}` },
        body: form,
      }),
    );
    expect(upload.status).toBe(200);

    const detail = await adminGet(`${ADMIN_REPORTS_PATH}/${reportId}`);
    const { report } = (await detail.json()) as {
      report: { artifacts: Array<{ artifactId: string; filename: string | null }> };
    };
    const hostile = report.artifacts.find(a => a.filename === "evil.html")!;

    const res = await adminGet(`${ADMIN_REPORTS_PATH}/${reportId}/artifacts/${hostile.artifactId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toStartWith("attachment;");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

// === Helpers ===

function adminGet(url: string): Promise<Response> {
  return keyGet(url, adminBearer);
}

function keyGet(url: string, bearer: string): Promise<Response> {
  return coreApp.fetch(new Request(url, { headers: { authorization: `Bearer ${bearer}` } }));
}

/** Submit a bug report with one log bundle and one screenshot; returns the reportId. */
async function listed(query: string): Promise<Array<{ reportId: string; kind: string; mentraUserId: string }>> {
  const response = await adminGet(`${ADMIN_REPORTS_PATH}?${query}`);
  expect(response.status).toBe(200);
  return (await response.json() as { reports: Array<{ reportId: string; kind: string; mentraUserId: string }> }).reports;
}

async function seedReport(actualBehavior: string, screenshot?: Buffer): Promise<string> {
  const submit = await coreApp.fetch(
    new Request(REPORTS_PATH, {
      method: "POST",
      headers: { authorization: `Bearer ${userAccessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "bug",
        trigger: { type: "manual", source: "feedback_screen", reason: "manual_bug_report" },
        report: { actualBehavior },
        context: { app: { appVersion: "test" } },
      }),
    }),
  );
  expect(submit.status).toBe(200);
  const { reportId } = (await submit.json()) as { reportId: string };

  const logs = await coreApp.fetch(
    new Request(`${REPORTS_PATH}/${reportId}/artifacts`, {
      method: "POST",
      headers: { authorization: `Bearer ${userAccessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        type: "logs",
        source: "glasses",
        entries: [{ timestamp: 1700000000001, level: "info", message: "glasses connected" }],
      }),
    }),
  );
  expect(logs.status).toBe(200);

  const form = new FormData();
  form.append("files", new File([screenshot ?? crypto.randomBytes(512)], "shot.jpg", { type: "image/jpeg" }));
  const shots = await coreApp.fetch(
    new Request(`${REPORTS_PATH}/${reportId}/artifacts`, {
      method: "POST",
      headers: { authorization: `Bearer ${userAccessToken}` },
      body: form,
    }),
  );
  expect(shots.status).toBe(200);

  return reportId;
}

async function exchange(jwt: string): Promise<Response> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: jwt,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
  });
  return coreApp.fetch(
    new Request("http://localhost/api/client/auth/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }),
  );
}

/** Mint an HS256 JWT shaped like a Supabase session token. */
function mintSupabaseJwt(sub: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      sub,
      iss: `${process.env.SUPABASE_URL}/auth/v1`,
      aud: "authenticated",
      role: "authenticated",
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const sig = crypto
    .createHmac("sha256", process.env.SUPABASE_JWT_SECRET!)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${sig}`;
}

function b64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function stripPemWrap(pem: string): string {
  return pem
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "");
}
