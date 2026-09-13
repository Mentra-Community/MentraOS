/**
 * @fileoverview Admin report triage API integration tests.
 *
 * Covers the adminAuth-gated read surface behind the internal admin console:
 * list (filters, context excluded), detail (context + asset rows), artifact
 * payload bytes, and the auth gate itself (401 without credentials, 403 for a
 * non-allowlisted principal).
 *
 * Admin auth uses the org API-key bearer path: an `msk_…` token is not a JWT,
 * so authenticateBearerToken falls through to the local DB validation without
 * touching WorkOS, and the resulting synthetic `api-key@{keyId}.local` email
 * is allowlisted via CLOUD_CORE_ADMIN_EMAILS. Fully local — no WorkOS needed.
 *
 * Prereq: a running Mongo. Defaults to
 * `mongodb://127.0.0.1:27017/mentra-cloud-v2-test`; override via `MONGO_URL`.
 * The test wipes its own collections between cases — do NOT point at a real DB.
 *
 * Run: `bun test tests/admin-reports.integration.test.ts`
 */

import crypto from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

const STORAGE_DIR = join(tmpdir(), `mentra-admin-reports-test-${process.pid}`);
const savedAdminEmails = process.env.CLOUD_CORE_ADMIN_EMAILS;
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
  process.env.SUPABASE_URL = "https://testproj.supabase.co";
  process.env.CLOUD_CORE_LOCAL_STORAGE_DIR = STORAGE_DIR;
  // Pin the API-key environment label so minted keys validate deterministically.
  process.env.CLOUD_CORE_ENVIRONMENT = "local";
  process.env.WORKOS_API_KEY = "test-workos-service-secret";
  process.env.MENTRA_CORE_INTERNAL_URL = "http://core.internal";
}

// eslint-disable-next-line import/first
import {
  connectMongo,
  disconnectMongo,
  mongoReadinessCheck,
} from "../packages/core/src/connections/mongo.connection";
import { createApp } from "../packages/core/src/api/app";
import { createApp as createStoreApp } from "../packages/store/src/api/app";
import { ReportModel } from "../packages/core/src/models/report.model";
import { ReportAssetModel } from "../packages/core/src/models/report-asset.model";
import { UserModel } from "../packages/core/src/models/user.model";
import { RefreshTokenModel } from "../packages/core/src/models/refresh-token.model";
import { SeenJtiModel } from "../packages/core/src/models/seen-jti.model";
import { RevokedJtiModel } from "../packages/core/src/models/revoked-jti.model";
import { DeveloperOrgApiKeyModel } from "../packages/store/src/models/developer-org-api-key.model";
import { DeveloperApiKeyService } from "../packages/store/src/services/developer-orgs/developer-api-key.service";

const REPORTS_PATH = "http://localhost/api/client/reports";
const ADMIN_REPORTS_PATH = "http://localhost/api/admin/reports";

let coreApp: ReturnType<typeof createApp>;
let storeApp: ReturnType<typeof createStoreApp>;
const nativeFetch = globalThis.fetch;
let userAccessToken: string;
let adminBearer: string;
let nonAdminBearer: string;

beforeAll(async () => {
  await connectMongo(process.env.MONGO_URL!);
  await Promise.all([
    ReportModel.syncIndexes(),
    ReportAssetModel.syncIndexes(),
    UserModel.syncIndexes(),
    RefreshTokenModel.syncIndexes(),
    SeenJtiModel.syncIndexes(),
    RevokedJtiModel.syncIndexes(),
    DeveloperOrgApiKeyModel.syncIndexes(),
  ]);
  coreApp = createApp({ readinessChecks: [mongoReadinessCheck] });
  storeApp = createStoreApp({ readinessChecks: [mongoReadinessCheck] });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("http://core.internal/")) {
      return coreApp.fetch(input instanceof Request ? input : new Request(url, init));
    }
    return nativeFetch(input, init);
  }) as typeof fetch;

  const exchanged = await exchange(mintSupabaseJwt("admin-reports-user-1"));
  expect(exchanged.status).toBe(200);
  userAccessToken = ((await exchanged.json()) as { access_token: string }).access_token;

  const apiKeys = new DeveloperApiKeyService();
  const adminKey = await apiKeys.create("org_admin_reports_test", "admin", "user_admin", "local");
  const nonAdminKey = await apiKeys.create("org_admin_reports_test", "plain", "user_plain", "local");
  adminBearer = adminKey.value!;
  nonAdminBearer = nonAdminKey.value!;
  process.env.CLOUD_CORE_ADMIN_EMAILS = `api-key@${adminKey.id}.local`;
});

afterAll(async () => {
  if (savedAdminEmails === undefined) delete process.env.CLOUD_CORE_ADMIN_EMAILS;
  else process.env.CLOUD_CORE_ADMIN_EMAILS = savedAdminEmails;
  await DeveloperOrgApiKeyModel.deleteMany({ orgId: "org_admin_reports_test" });
  globalThis.fetch = nativeFetch;
  await disconnectMongo();
  await rm(STORAGE_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  await Promise.all([
    ReportModel.deleteMany({}),
    ReportAssetModel.deleteMany({}),
  ]);
});

describe("admin reports auth gate", () => {
  test("rejects requests without credentials and non-admin principals", async () => {
    const anonymous = await storeApp.fetch(new Request(ADMIN_REPORTS_PATH));
    expect(anonymous.status).toBe(401);

    const forbidden = await storeApp.fetch(
      new Request(ADMIN_REPORTS_PATH, { headers: { authorization: `Bearer ${nonAdminBearer}` } }),
    );
    expect(forbidden.status).toBe(403);
  });
});

describe("admin reports read surface", () => {
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
  return storeApp.fetch(new Request(url, { headers: { authorization: `Bearer ${adminBearer}` } }));
}

/** Submit a bug report with one log bundle and one screenshot; returns the reportId. */
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
