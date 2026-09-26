/**
 * @fileoverview Reports API integration tests.
 *
 * Covers the artifact asset store (screenshot and log payloads land in blob
 * storage described by `report_assets` rows, while the `reports` document
 * keeps metadata only) and the upload size limits (per-file, file count, and
 * the router-wide body cap).
 *
 * Wires the core in-process via app.fetch and authenticates through the real
 * Supabase-subject token exchange, mirroring auth.mentra-user-exchange tests.
 *
 * Prereq: a running Mongo. Defaults to
 * `mongodb://127.0.0.1:27017/mentra-cloud-v2-test`; override via `MONGO_URL`.
 * The test wipes its own collections between cases — do NOT point at a real DB.
 *
 * Run: `bun test tests/reports.integration.test.ts`
 */

import crypto from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

// Crypto material and the storage root must be set BEFORE core reads them.
// Signing keys are loaded lazily and the report service creates its storage
// provider on first use, so setting env at module evaluation is early enough.
const STORAGE_DIR = join(tmpdir(), `mentra-reports-test-${process.pid}`);
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
  // Only the Slack notification tests opt in to a (mocked) webhook; everything
  // else must run with the notifier disabled, whatever the shell env says. The
  // bot-token transport is a second way to switch it on, so it is cleared too.
  delete process.env.CLOUD_REPORTS_SLACK_WEBHOOK_URL;
  delete process.env.CLOUD_REPORTS_SLACK_WEBHOOK_AUTOMATIC_URL;
  delete process.env.CLOUD_REPORTS_SLACK_BOT_TOKEN;
  delete process.env.CLOUD_REPORTS_SLACK_CHANNEL_ID;
  delete process.env.CLOUD_REPORTS_SLACK_CHANNEL_ID_AUTOMATIC;
}

// eslint-disable-next-line import/first
import {
  connectMongo,
  disconnectMongo,
  mongoReadinessCheck,
} from "../packages/core/src/connections/mongo.connection";
import { createApp } from "../packages/core/src/api/app";
import { ReportModel } from "../packages/core/src/models/report.model";
import { ReportAssetModel } from "../packages/core/src/models/report-asset.model";
import { UserModel } from "../packages/core/src/models/user.model";
import { RefreshTokenModel } from "../packages/core/src/models/refresh-token.model";
import { SeenJtiModel } from "../packages/core/src/models/seen-jti.model";
import { RevokedJtiModel } from "../packages/core/src/models/revoked-jti.model";
import { getReport } from "../packages/core/src/services/report.service";
import {
  createStorageService,
  sha256Hex,
  StorageService,
} from "../packages/core/src/services/storage/storage.service";

// Mirrors the limits in api/client/reports.api.ts.
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_ATTACHMENT_BYTES = 20 * 1024 * 1024;
// Genuine synthetic silent H264 MP4 (64x64, 10 frames, no audio), written by
// AVFoundation. It exercises a real encoded file end to end; browser playback
// is still qualified separately.
const H264_FIXTURE = new URL("./fixtures/synthetic-silent-h264-64x64-10f.mp4", import.meta.url);
const MAX_ATTACHMENT_FILES = 5;
const MAX_REQUEST_BODY_BYTES =
  MAX_ATTACHMENT_BYTES * MAX_ATTACHMENT_FILES + 1024 * 1024;

const REPORTS_PATH = "http://localhost/api/client/reports";

let coreApp: ReturnType<typeof createApp>;
let accessToken: string;
let mentraUserId: string;

beforeAll(async () => {
  await connectMongo(process.env.MONGO_URL!);
  await Promise.all([
    ReportModel.syncIndexes(),
    ReportAssetModel.syncIndexes(),
    UserModel.syncIndexes(),
    RefreshTokenModel.syncIndexes(),
    SeenJtiModel.syncIndexes(),
    RevokedJtiModel.syncIndexes(),
  ]);
  coreApp = createApp({ readinessChecks: [mongoReadinessCheck] });

  const res = await exchange(mintSupabaseJwt("reports-user-1"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { access_token: string };
  accessToken = body.access_token;
  mentraUserId = decodeJwtPayload(accessToken).sub as string;
});

afterAll(async () => {
  await disconnectMongo();
  await rm(STORAGE_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  await Promise.all([
    ReportModel.deleteMany({}),
    ReportAssetModel.deleteMany({}),
  ]);
});

describe("reports artifact asset store", () => {
  test("stores screenshot payloads in blob storage, keeping the report metadata-only", async () => {
    const reportId = await submitBugReport();
    const imageA = crypto.randomBytes(2048);
    const imageB = crypto.randomBytes(4096);

    const form = new FormData();
    form.append("type", "screenshot");
    form.append("source", "phone");
    form.append("files", new File([imageA], "one.jpg", { type: "image/jpeg" }));
    form.append("files", new File([imageB], "two.png", { type: "image/png" }));

    const res = await postArtifacts(reportId, form);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stored: 2 });

    // The stored document embeds metadata only — no payload fields at all.
    const doc = await ReportModel.collection.findOne({ reportId });
    const artifacts = (doc?.artifacts ?? []) as Array<Record<string, unknown>>;
    expect(artifacts).toHaveLength(2);
    for (const artifact of artifacts) {
      expect(artifact.type).toBe("screenshot");
      expect(artifact.source).toBe("phone");
      expect(typeof artifact.artifactId).toBe("string");
      expect("dataBase64" in artifact).toBe(false);
      expect("data" in artifact).toBe(false);
    }

    // Each artifact has an asset row and the blob round-trips byte-for-byte.
    const storage = createStorageService();
    for (const [bytes, name, contentType] of [
      [imageA, "one.jpg", "image/jpeg"],
      [imageB, "two.png", "image/png"],
    ] as const) {
      const artifact = artifacts.find((a) => a.filename === name);
      expect(artifact?.contentType).toBe(contentType);
      expect(artifact?.sizeBytes).toBe(bytes.byteLength);

      const asset = await ReportAssetModel.findOne({
        artifactId: artifact?.artifactId,
      }).lean();
      expect(asset?.reportId).toBe(reportId);
      expect(asset?.mentraUserId).toBe(mentraUserId);
      expect(asset?.fileName).toBe(name);
      expect(asset?.contentType).toBe(contentType);
      expect(asset?.sizeBytes).toBe(bytes.byteLength);
      expect(asset?.sha256).toBe(sha256Hex(bytes));
      expect(asset?.storageKey).toStartWith(`reports/${reportId}/`);

      const stored = await storage.getObject(asset!.storageKey);
      expect(Buffer.from(stored).equals(bytes)).toBe(true);
    }
  });

  test("stores log bundles in blob storage and round-trips the entries", async () => {
    const reportId = await submitBugReport();
    const entries = [
      { timestamp: 1700000000001, level: "info", message: "glasses connected" },
      { timestamp: 1700000000002, level: "error", message: "ota failed", source: "asg" },
    ];

    const res = await coreApp.fetch(
      new Request(`${REPORTS_PATH}/${reportId}/artifacts`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ type: "logs", source: "glasses", entries }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stored: 1 });

    const doc = await ReportModel.collection.findOne({ reportId });
    const artifacts = (doc?.artifacts ?? []) as Array<Record<string, unknown>>;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].type).toBe("logs");
    expect(artifacts[0].source).toBe("glasses");
    expect(artifacts[0].contentType).toBe("application/json");
    expect("data" in artifacts[0]).toBe(false);
    expect("dataBase64" in artifacts[0]).toBe(false);

    const asset = await ReportAssetModel.findOne({
      artifactId: artifacts[0].artifactId,
    }).lean();
    expect(asset?.contentType).toBe("application/json");

    const stored = await createStorageService().getObject(asset!.storageKey);
    expect(JSON.parse(Buffer.from(stored).toString("utf8"))).toEqual({ entries });

    const complete = await coreApp.fetch(
      new Request(`${REPORTS_PATH}/${reportId}/complete`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(complete.status).toBe(200);
    expect(await complete.json()).toEqual({ status: "ready" });
  });

  test("returns 404 for an unknown report without storing anything", async () => {
    const form = new FormData();
    form.append("files", new File([crypto.randomBytes(16)], "s.jpg", { type: "image/jpeg" }));

    const res = await postArtifacts("rep_does_not_exist", form);
    expect(res.status).toBe(404);
    expect(await ReportAssetModel.countDocuments({})).toBe(0);
  });

  test("retrieves ordered report assets using an available sort index", async () => {
    const reportId = await submitBugReport();
    const form = new FormData();
    form.append("files", new File([new Uint8Array([1])], "one.png", { type: "image/png" }));
    form.append("files", new File([new Uint8Array([2])], "two.png", { type: "image/png" }));
    expect((await postArtifacts(reportId, form)).status).toBe(200);
    // Force a known order that differs from insertion order. The explicit hint
    // reproduces Cosmos's requirement: ordinary Mongo otherwise permits an
    // unindexed sort and would miss this deployment failure.
    await ReportAssetModel.collection.updateOne({ reportId, fileName: "one.png" }, { $set: { createdAt: new Date(2000) } });
    await ReportAssetModel.collection.updateOne({ reportId, fileName: "two.png" }, { $set: { createdAt: new Date(1000) } });
    const indexed = await ReportAssetModel.find({ reportId }).sort({ createdAt: 1 }).hint({ createdAt: 1 }).lean();
    expect(indexed.map(asset => asset.fileName)).toEqual(["two.png", "one.png"]);
    const detail = await getReport(reportId);
    expect(detail?.assets.map(asset => asset.artifactId)).toEqual(indexed.map(asset => asset.artifactId));
  });
});

describe("reports upload limits", () => {
  test("rejects an artifact over the per-file limit before storing anything", async () => {
    const reportId = await submitBugReport();
    const oversized = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);

    const form = new FormData();
    form.append("files", new File([oversized], "huge.jpg", { type: "image/jpeg" }));

    const res = await postArtifacts(reportId, form);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("invalid_request");
    expect(body.error_description).toContain("exceeds");

    const doc = await ReportModel.collection.findOne({ reportId });
    expect(doc?.artifacts ?? []).toHaveLength(0);
    expect(await ReportAssetModel.countDocuments({})).toBe(0);
  });

  test("rejects more artifact files than the per-request cap", async () => {
    const reportId = await submitBugReport();

    const form = new FormData();
    for (let i = 0; i < MAX_ATTACHMENT_FILES + 1; i++) {
      form.append("files", new File([crypto.randomBytes(8)], `s${i}.jpg`, { type: "image/jpeg" }));
    }

    const res = await postArtifacts(reportId, form);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("invalid_request");
    expect(body.error_description).toContain("too many artifact files");
    expect(await ReportAssetModel.countDocuments({})).toBe(0);
  });

  test("caps the raw request body at the router-wide limit", async () => {
    const reportId = await submitBugReport();
    // One byte over the router cap, sent as an opaque multipart body so the
    // limit has to trip while the stream is being read.
    const body = new Uint8Array(MAX_REQUEST_BODY_BYTES + 1);

    const res = await coreApp.fetch(
      new Request(`${REPORTS_PATH}/${reportId}/artifacts`, {
        method: "POST",
        headers: {
          ...authHeaders(),
          "content-type": "multipart/form-data; boundary=deadbeef",
        },
        body,
      }),
    );
    expect(res.status).toBe(413);
    const parsed = (await res.json()) as { error: string; error_description: string };
    expect(parsed.error).toBe("invalid_request");
    expect(parsed.error_description).toContain("exceeds");
    expect(await ReportAssetModel.countDocuments({})).toBe(0);
  });
});

describe("report MP4 video artifacts", () => {
  test("appends a genuine H264 MP4 to an existing ready report as a host video, preserving the report", async () => {
    const reportId = await submitBugReport();
    const logs = await coreApp.fetch(
      new Request(`${REPORTS_PATH}/${reportId}/artifacts`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          type: "logs",
          source: "glasses",
          entries: [{ timestamp: 1700000000001, level: "info", message: "before video" }],
        }),
      }),
    );
    expect(logs.status).toBe(200);
    expect((await completeReport(reportId)).status).toBe(200);
    const before = await ReportModel.collection.findOne({ reportId });
    expect(before?.status).toBe("ready");

    const video = await readFile(H264_FIXTURE);
    const res = await postArtifacts(
      reportId,
      videoForm("host", new File([video], "recording.mp4", { type: "video/mp4" })),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stored: 1 });

    // The report narrative, context, status and original logs are untouched.
    const after = await ReportModel.collection.findOne({ reportId });
    expect(after?.status).toBe("ready");
    expect(after?.context).toEqual(before?.context);
    expect(after?.report).toEqual(before?.report);
    const artifacts = (after?.artifacts ?? []) as Array<Record<string, unknown>>;
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]).toEqual((before?.artifacts as Array<Record<string, unknown>>)[0]);
    expect(artifacts[1]).toMatchObject({
      type: "video",
      source: "host",
      filename: "recording.mp4",
      contentType: "video/mp4",
      sizeBytes: video.byteLength,
    });

    const asset = await ReportAssetModel.findOne({ artifactId: artifacts[1].artifactId }).lean();
    expect(asset?.contentType).toBe("video/mp4");
    expect(asset?.sizeBytes).toBe(video.byteLength);
    expect(asset?.sha256).toBe(sha256Hex(video));
    const stored = await createStorageService().getObject(asset!.storageKey);
    expect(Buffer.from(stored).equals(video)).toBe(true);

    const detail = await getReport(reportId);
    expect(detail?.report.artifacts[1]).toMatchObject({ type: "video", source: "host", contentType: "video/mp4" });
  });

  test("admits a transport-sized video body above the screenshot limit", async () => {
    const reportId = await submitBugReport();
    // Size boundary only: these bytes are not decodable video.
    const body = isoHeaderedBytes(16_638_399);
    const res = await postArtifacts(reportId, videoForm("host", new File([body], "large.mp4", { type: "video/mp4" })));
    expect(res.status).toBe(200);

    const doc = await ReportModel.collection.findOne({ reportId });
    const artifact = ((doc?.artifacts ?? []) as Array<Record<string, unknown>>)[0];
    expect(artifact).toMatchObject({ type: "video", sizeBytes: body.byteLength });
    const asset = await ReportAssetModel.findOne({ artifactId: artifact.artifactId }).lean();
    expect(asset?.sha256).toBe(sha256Hex(body));
  });

  test("requires the report owner's authentication and an existing report", async () => {
    const reportId = await submitBugReport();
    const upload = async () =>
      videoForm("host", new File([await readFile(H264_FIXTURE)], "clip.mp4", { type: "video/mp4" }));

    // The user auth middleware reports missing or invalid credentials as
    // OAuth 400s, before the upload is read.
    const anonymous = await coreApp.fetch(
      new Request(`${REPORTS_PATH}/${reportId}/artifacts`, { method: "POST", body: await upload() }),
    );
    expect(anonymous.status).toBe(400);
    expect(((await anonymous.json()) as { error: string }).error).toBe("invalid_request");
    const forged = await coreApp.fetch(
      new Request(`${REPORTS_PATH}/${reportId}/artifacts`, {
        method: "POST",
        headers: { authorization: "Bearer not-a-real-token" },
        body: await upload(),
      }),
    );
    expect(forged.status).toBe(400);
    expect(((await forged.json()) as { error: string }).error).toBe("invalid_grant");

    const other = await exchange(mintSupabaseJwt("reports-user-2"));
    expect(other.status).toBe(200);
    const otherToken = ((await other.json()) as { access_token: string }).access_token;
    const foreign = await coreApp.fetch(
      new Request(`${REPORTS_PATH}/${reportId}/artifacts`, {
        method: "POST",
        headers: { authorization: `Bearer ${otherToken}` },
        body: await upload(),
      }),
    );
    expect(foreign.status).toBe(404);

    expect((await postArtifacts("rep_does_not_exist", await upload())).status).toBe(404);

    const doc = await ReportModel.collection.findOne({ reportId });
    expect(doc?.artifacts ?? []).toHaveLength(0);
    expect(await ReportAssetModel.countDocuments({})).toBe(0);
  });

  test("rejects unsupported video declarations and sizes before storing anything", async () => {
    const reportId = await submitBugReport();
    const fixture = await readFile(H264_FIXTURE);
    const mp4 = (bytes: Uint8Array | string, name = "clip.mp4") => new File([bytes], name, { type: "video/mp4" });
    const typed = (type: string, file: File) => {
      const form = new FormData();
      form.append("type", type);
      form.append("files", file);
      return form;
    };
    const cases: Array<[FormData, string]> = [
      [videoForm("host", new File([fixture], "clip.png", { type: "image/png" })), "must be declared video/mp4"],
      [videoForm("host", new File([fixture], "clip.mov", { type: "video/quicktime" })), "must be declared video/mp4"],
      [videoForm(null, mp4(fixture)), "source label"],
      [videoForm("../host", mp4(fixture)), "source label"],
      [videoForm("host", mp4(isoHeaderedBytes(MAX_VIDEO_ATTACHMENT_BYTES + 1))), "exceeds"],
      [videoForm("host", mp4("<script>alert(1)</script>")), "no MP4 file header"],
      [videoForm("host", mp4(new Uint8Array(0))), "no MP4 file header"],
      // A video never falls back to the screenshot contract.
      [typed("screenshot", mp4(fixture)), "upload it with type=video"],
      [(() => { const form = new FormData(); form.append("files", mp4(fixture)); return form; })(), "upload it with type=video"],
      // Screenshots keep their own 10 MiB limit whatever the bytes are.
      [typed("screenshot", new File([isoHeaderedBytes(MAX_ATTACHMENT_BYTES + 1)], "big.png", { type: "image/png" })), "exceeds"],
      [typed("recording", mp4(fixture)), "unsupported multipart artifact type"],
    ];
    for (const [form, message] of cases) {
      const res = await postArtifacts(reportId, form);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; error_description: string };
      expect(body.error).toBe("invalid_request");
      expect(body.error_description).toContain(message);
    }
    const doc = await ReportModel.collection.findOne({ reportId });
    expect(doc?.artifacts ?? []).toHaveLength(0);
    expect(await ReportAssetModel.countDocuments({})).toBe(0);
  });

  test("rejects a whole multipart video batch before storing any of it", async () => {
    const reportId = await submitBugReport();
    const prior = await uploadScreenshot(reportId);

    const res = await postArtifacts(reportId, videoForm(
      "host",
      new File([await readFile(H264_FIXTURE)], "ok.mp4", { type: "video/mp4" }),
      new File([crypto.randomBytes(64)], "fake.mp4", { type: "video/mp4" }),
    ));
    expect(res.status).toBe(400);

    await expectOnlyArtifact(reportId, prior);
  });

  for (const [stage, inject] of [
    ["blob storage", failSecondPutObject],
    ["report metadata append", failNextArtifactAppend],
  ] as const) {
    test(`a failed ${stage} rolls back the videos and preserves prior artifacts`, async () => {
      const reportId = await submitBugReport();
      const prior = await uploadScreenshot(reportId);

      const form = videoForm(
        "host",
        new File([await readFile(H264_FIXTURE)], "one.mp4", { type: "video/mp4" }),
        new File([isoHeaderedBytes(8192)], "two.mp4", { type: "video/mp4" }),
      );
      const restore = inject();
      const res = await postArtifacts(reportId, form).finally(restore);
      expect(res.status).toBe(500);

      await expectOnlyArtifact(reportId, prior);
    });
  }
});

describe("report Slack notifications", () => {
  const SLACK_WEBHOOK = "https://hooks.slack.test/services/T0/B0/reports";
  const realFetch = globalThis.fetch;
  let slackCalls: Array<{ url: string; payload: { text: string; blocks: unknown[] } }>;

  // The in-process app is invoked via coreApp.fetch (a plain handler call),
  // so replacing globalThis.fetch intercepts only the notifier's outbound
  // webhook POST.
  beforeEach(() => {
    process.env.CLOUD_REPORTS_SLACK_WEBHOOK_URL = SLACK_WEBHOOK;
    slackCalls = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      slackCalls.push({
        url: String(input),
        payload: JSON.parse(String(init?.body)) as { text: string; blocks: unknown[] },
      });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.CLOUD_REPORTS_SLACK_WEBHOOK_URL;
  });

  test("notifies Slack when feedback is submitted", async () => {
    const res = await coreApp.fetch(
      new Request(REPORTS_PATH, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          kind: "feedback",
          feedback: { type: "feature", message: "please add a dark mode" },
          context: {},
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reportId: string; status: string };
    expect(body.status).toBe("ready");

    // The notifier fires before the response resolves (fire-and-forget, but
    // the webhook call starts synchronously), so no waiting is needed.
    expect(slackCalls).toHaveLength(1);
    expect(slackCalls[0].url).toBe(SLACK_WEBHOOK);
    expect(slackCalls[0].payload.text).toContain("feedback");
    expect(slackCalls[0].payload.text).toContain(body.reportId);
    expect(slackCalls[0].payload.text).toContain(mentraUserId);
    expect(JSON.stringify(slackCalls[0].payload.blocks)).toContain("please add a dark mode");
  });

  test("notifies once with the artifact count when a bug report completes", async () => {
    const reportId = await submitBugReport();
    expect(slackCalls).toHaveLength(0);

    const form = new FormData();
    form.append("type", "screenshot");
    form.append("source", "phone");
    form.append("files", new File([crypto.randomBytes(64)], "a.jpg", { type: "image/jpeg" }));
    form.append("files", new File([crypto.randomBytes(64)], "b.jpg", { type: "image/jpeg" }));
    expect((await postArtifacts(reportId, form)).status).toBe(200);
    expect(slackCalls).toHaveLength(0);

    const complete = await completeReport(reportId);
    expect(complete.status).toBe(200);
    expect(slackCalls).toHaveLength(1);
    expect(slackCalls[0].payload.text).toContain("bug");
    expect(slackCalls[0].payload.text).toContain(reportId);
    expect(slackCalls[0].payload.text).toContain("Artifacts: 2");
    const blocksJson = JSON.stringify(slackCalls[0].payload.blocks);
    expect(blocksJson).toContain("manual_bug_report");
    expect(blocksJson).toContain("the app crashed");

    // Repeated /complete calls keep the API response but stay silent.
    const again = await completeReport(reportId);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: "ready" });
    expect(slackCalls).toHaveLength(1);
  });

  test("submits successfully with no Slack call when the webhook env is unset", async () => {
    delete process.env.CLOUD_REPORTS_SLACK_WEBHOOK_URL;

    const res = await coreApp.fetch(
      new Request(REPORTS_PATH, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ kind: "feedback", feedback: "plain text note", context: {} }),
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("ready");
    expect(slackCalls).toHaveLength(0);
  });
});

// === Helpers ===

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${accessToken}` };
}

async function submitBugReport(): Promise<string> {
  const res = await coreApp.fetch(
    new Request(REPORTS_PATH, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        kind: "bug",
        trigger: { type: "manual", source: "feedback_screen", reason: "manual_bug_report" },
        report: { actualBehavior: "the app crashed" },
        context: { app: { appVersion: "test" } },
      }),
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { reportId: string; status: string };
  expect(body.status).toBe("collecting");
  return body.reportId;
}

function postArtifacts(reportId: string, form: FormData): Promise<Response> {
  return coreApp.fetch(
    new Request(`${REPORTS_PATH}/${reportId}/artifacts`, {
      method: "POST",
      headers: authHeaders(),
      body: form,
    }),
  );
}

/** A `type=video` multipart upload with an optional declared capture source. */
function videoForm(source: string | null, ...files: File[]): FormData {
  const form = new FormData();
  form.append("type", "video");
  if (source !== null) form.append("source", source);
  for (const file of files) form.append("files", file);
  return form;
}

/**
 * Transport-sized bytes behind an ISO `ftyp` header: an `mdat` box of random
 * data. They pass the upload's header check and exercise size limits and
 * storage only. They are NOT decodable video; use H264_FIXTURE for that.
 */
function isoHeaderedBytes(size: number): Buffer {
  const ftyp = Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from("ftypisom"),
    Buffer.from([0, 0, 2, 0]),
    Buffer.from("isommp41"),
  ]);
  const mdatSize = size - ftyp.byteLength;
  const mdatHeader = Buffer.alloc(8);
  mdatHeader.writeUInt32BE(mdatSize, 0);
  mdatHeader.write("mdat", 4, "latin1");
  return Buffer.concat([ftyp, mdatHeader, crypto.randomBytes(mdatSize - 8)]);
}

async function uploadScreenshot(reportId: string): Promise<string> {
  const form = new FormData();
  form.append("files", new File([crypto.randomBytes(256)], "prior.jpg", { type: "image/jpeg" }));
  expect((await postArtifacts(reportId, form)).status).toBe(200);
  const doc = await ReportModel.collection.findOne({ reportId });
  return ((doc?.artifacts ?? []) as Array<{ artifactId: string }>)[0].artifactId;
}

/** The report keeps exactly its earlier artifact: no new metadata, asset rows or blobs. */
async function expectOnlyArtifact(reportId: string, artifactId: string): Promise<void> {
  const doc = await ReportModel.collection.findOne({ reportId });
  expect(((doc?.artifacts ?? []) as Array<{ artifactId: string }>).map((a) => a.artifactId)).toEqual([artifactId]);
  const assets = await ReportAssetModel.find({ reportId }).lean();
  expect(assets.map((asset) => asset.artifactId)).toEqual([artifactId]);
  const blobs = await readdir(join(STORAGE_DIR, "reports", reportId));
  expect(blobs).toEqual([artifactId]);
}

/** Let the first blob write succeed and fail the second one. */
function failSecondPutObject(): () => void {
  const original = StorageService.prototype.putObject;
  let calls = 0;
  StorageService.prototype.putObject = function (this: StorageService, input) {
    calls += 1;
    if (calls === 2) return Promise.reject(new Error("injected storage failure"));
    return original.call(this, input);
  };
  return () => {
    StorageService.prototype.putObject = original;
  };
}

/** Fail the metadata push after every blob and asset row was written. */
function failNextArtifactAppend(): () => void {
  const original = ReportModel.updateOne;
  let failed = false;
  const patched = function (this: unknown, ...args: unknown[]) {
    const update = args[1];
    if (!failed && update && typeof update === "object" && "$push" in update) {
      failed = true;
      throw new Error("injected metadata append failure");
    }
    return (original as (...params: unknown[]) => unknown).apply(this, args);
  };
  ReportModel.updateOne = patched as unknown as typeof original;
  return () => {
    ReportModel.updateOne = original;
  };
}

function completeReport(reportId: string): Promise<Response> {
  return coreApp.fetch(
    new Request(`${REPORTS_PATH}/${reportId}/complete`, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: "{}",
    }),
  );
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

function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

function stripPemWrap(pem: string): string {
  return pem
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "");
}
