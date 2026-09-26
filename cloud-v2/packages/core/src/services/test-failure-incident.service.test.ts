import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createTestFailureAgentApi } from "../api/agent/test-failures.api";
import type { ContinuationGrant } from "../types/test-continuation.types";
import { signTestContinuationGrant, signTestFailureReadGrant } from "./test-failure-auth";
import { INCIDENT_DIAGNOSTIC_LIMITS, REDACTED_EMAIL, REDACTED_LINE, TestFailureIncidentService, logLevel, omittedTextMarker,
  projectIncidentLog, redactDiagnosticText, sourceLabel, type IncidentReportStore } from "./test-failure-incident.service";
import { TestRunError, type TestRunService } from "./test-run.service";

// Synthetic fixtures only: no real report contents, identities or credentials.
const secret = "incident-diagnostics-test-only-".repeat(2);
const occurrenceId = "tfo_" + "1".repeat(64), otherOccurrence = "tfo_" + "2".repeat(64);
const assigned = "rep_01SYNTHETICASSIGNED", unrelated = "rep_01SYNTHETICUNRELATED";
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const bundle = (entries: unknown[]) => Buffer.from(JSON.stringify({ entries }), "utf8");
const body = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
/**
 * A JWT-shaped string that is not a credential: an unsigned (`alg: none`) header, a synthetic
 * subject and the literal signature `synthetic`. Assembled at run time so the source holds no
 * credential-shaped literal for secret scanners to flag.
 */
const base64url = (value: string) => Buffer.from(value, "utf8").toString("base64url");
const syntheticJwt = [JSON.stringify({ alg: "none", typ: "JWT" }), JSON.stringify({ sub: "synthetic" }), "synthetic"].map(base64url).join(".");

const maxChars = INCIDENT_DIAGNOSTIC_LIMITS.maxMessageChars;
/** `head`, then `unit` repeated, then `tail`: exactly `length` characters (default: the message bound). */
const dense = (unit: string, head = "", tail = "", length = maxChars) =>
  head + unit.repeat(Math.ceil(length / unit.length)).slice(0, length - head.length - tail.length) + tail;
/**
 * Maximum-length malformed shapes that made the earlier unanchored patterns rescan the same run
 * from every start position, with the result each now gets. Redacting or masking more is intended.
 */
const ADVERSARIAL: Array<{ name: string; value: string; expected: "redacted" | "masked" | "kept" }> = [
  { name: "overlapping JWT prefixes, no dot", value: dense("eyJ"), expected: "redacted" },
  { name: "JWT header then a dot and no payload", value: dense("A", "eyJ", "."), expected: "redacted" },
  { name: "dotted JWT-like segments", value: dense("eyJhbGciOiJ."), expected: "redacted" },
  { name: "email local part with no domain", value: dense("a", "", "@"), expected: "kept" },
  { name: "email domain with no top-level label", value: dense("a.", "x@"), expected: "masked" },
  { name: "repeated @ with no dot", value: dense("a@"), expected: "kept" },
  { name: "dotted local part with repeated @", value: dense("a.@"), expected: "masked" },
  { name: "URL userinfo with no @", value: dense("b:", "a://"), expected: "kept" },
  { name: "repeated URL schemes", value: dense("a://"), expected: "kept" },
  { name: "URL userinfo at the bound", value: dense("u", "https://", ":p@host.test"), expected: "redacted" },
  { name: "repeated vendor prefixes", value: dense("sk-"), expected: "redacted" },
  { name: "camelCase at every character", value: dense("aB"), expected: "kept" },
  { name: "a word start at every character", value: dense(",;"), expected: "kept" },
];

/**
 * Records, while active, the longest string given to any RegExp entry point and to any string
 * transform, and how many RegExp calls were made. Structural, not timed.
 */
function observeStringWork() {
  let longestPattern = 0, longestTransform = 0, patternCalls = 0;
  const undo: Array<() => void> = [];
  const length = (value: unknown) => typeof value === "string" ? value.length : value instanceof String ? value.valueOf().length : 0;
  const wrap = (target: object, key: PropertyKey, note: (self: unknown, args: unknown[]) => void) => {
    const original = Reflect.get(target, key) as (...args: unknown[]) => unknown;
    Object.defineProperty(target, key, { configurable: true, writable: true,
      value: function (this: unknown, ...args: unknown[]) { note(this, args); return original.apply(this, args); } });
    undo.push(() => Object.defineProperty(target, key, { configurable: true, writable: true, value: original }));
  };
  for (const key of ["exec", "test", Symbol.replace, Symbol.match, Symbol.matchAll, Symbol.split, Symbol.search])
    wrap(RegExp.prototype, key, (_, args) => { patternCalls++; longestPattern = Math.max(longestPattern, length(args[0])); });
  for (const key of ["toLowerCase", "toUpperCase", "trim", "normalize"])
    wrap(String.prototype, key, self => { longestTransform = Math.max(longestTransform, length(self)); });
  return { get stats() { return { longestPattern, longestTransform, patternCalls, longest: Math.max(longestPattern, longestTransform) }; },
    restore: () => { for (const step of undo.reverse()) step(); undo.length = 0; } };
}
function observed<T>(run: () => T) {
  const observer = observeStringWork();
  try { return { result: run(), ...observer.stats }; } finally { observer.restore(); }
}
async function observedAsync<T>(run: () => Promise<T>) {
  const observer = observeStringWork();
  try { return { result: await run(), ...observer.stats }; } finally { observer.restore(); }
}
/**
 * Counts character reads (`charCodeAt`) and fixed-length comparisons (`startsWith`) made while
 * reviewing one string. A linear scan makes a constant number per character; an unanchored
 * rescan of a run would make hundreds per character at the message bound.
 */
function countScans<T>(run: () => T) {
  let scans = 0;
  const originals = { charCodeAt: String.prototype.charCodeAt, startsWith: String.prototype.startsWith };
  for (const [key, original] of Object.entries(originals))
    Object.defineProperty(String.prototype, key, { configurable: true, writable: true,
      value: function (this: string, ...args: unknown[]) { scans++; return (original as (...a: unknown[]) => unknown).apply(this, args); } });
  try { return { result: run(), scans }; }
  finally { for (const [key, original] of Object.entries(originals)) Object.defineProperty(String.prototype, key, { configurable: true, writable: true, value: original }); }
}

/** A bundle as close to maxSourceLogBytes as whole filler entries allow, ending with `tail`. */
function nearMaximumBundle(fillers: string[], tail: unknown[]) {
  const limit = INCIDENT_DIAGNOSTIC_LIMITS.maxSourceLogBytes, tailJson = tail.map(item => JSON.stringify(item)).join(",");
  const entry = (index: number) => JSON.stringify({ timestamp: index, level: "info", message: fillers[index % fillers.length], source: "phone" });
  const parts: string[] = [];
  for (let index = 0, size = `{"entries":[,${tailJson}]}`.length; ; index++) {
    const item = entry(index);
    if (size + item.length + 1 > limit) break;
    parts.push(item); size += item.length + 1;
  }
  const bytes = Buffer.from(`{"entries":[${parts.join(",")},${tailJson}]}`, "utf8");
  expect(bytes.byteLength).toBeLessThanOrEqual(limit);
  expect(bytes.byteLength).toBeGreaterThan(limit - 8 * 1024);
  return bytes;
}

interface ArtifactFixture {
  artifactId: string; type: "logs" | "screenshot" | "state_snapshot"; source: string; contentType?: string;
  bytes?: Uint8Array; assetMissing?: boolean; recordedSha256?: string; recordedSize?: number;
}
function memoryStore() {
  const reports = new Map<string, { report: Record<string, unknown>; artifacts: ArtifactFixture[] }>();
  const calls: string[] = [];
  const store: IncidentReportStore = {
    getReport: async id => {
      calls.push(`get:${id}`);
      const row = reports.get(id);
      if (!row) return null;
      return structuredClone({
        report: { reportId: id, kind: "bug", status: "ready", mentraUserId: "mu_synthetic_private", trigger: null, report: null,
          feedback: null, createdAt: "2026-09-25T08:00:00.000Z", updatedAt: "2026-09-25T08:01:00.000Z", context: {}, ...row.report,
          artifacts: row.artifacts.map(item => ({ artifactId: item.artifactId, type: item.type, source: item.source,
            filename: "synthetic-private-name.json", contentType: item.contentType ?? "application/json",
            sizeBytes: item.bytes?.byteLength ?? 0, createdAt: "2026-09-25T08:00:30.000Z" })) },
        assets: row.artifacts.filter(item => !item.assetMissing).map(item => ({ artifactId: item.artifactId,
          storageKey: `reports/${id}/${item.artifactId}`, fileName: "synthetic-private-name.json",
          contentType: item.contentType ?? "application/json", sizeBytes: item.recordedSize ?? item.bytes?.byteLength ?? 0,
          sha256: item.recordedSha256 ?? sha256(item.bytes ?? new Uint8Array()), createdAt: "2026-09-25T08:00:30.000Z" })),
      }) as Awaited<ReturnType<IncidentReportStore["getReport"]>>;
    },
    readReportArtifactPayload: async (reportId, artifactId) => {
      calls.push(`read:${reportId}/${artifactId}`);
      const item = reports.get(reportId)?.artifacts.find(value => value.artifactId === artifactId);
      if (!item || item.assetMissing) return null;
      if (!item.bytes) throw new Error("blob unavailable");
      // Same digest as this artifact's asset row above, like the real service.
      return { bytes: item.bytes, contentType: item.contentType ?? "application/json", fileName: "synthetic-private-name.json",
        sha256: item.recordedSha256 ?? sha256(item.bytes) };
    },
  };
  return { store, calls, reports, add: (id: string, report: Record<string, unknown>, artifacts: ArtifactFixture[]) => reports.set(id, { report, artifacts }) };
}
function runsWith(incidents: Record<string, string[]>) {
  return { failureDetail: async (id: string) => {
    if (!incidents[id]) throw new TestRunError(404, "failure occurrence not found");
    return { occurrenceId: id, failure: { incidentIds: incidents[id] } };
  } } as unknown as TestRunService;
}

const entries = [
  { timestamp: 1000, level: "info", message: "ScreenRecorder frame pts 4.000s did not advance (previous 4.000s)", source: "phone" },
  { timestamp: 1001, level: "debug", message: "Setting authToken for session", source: "phone" },
  { timestamp: 1002, level: "warn", message: "request header Authorization: Bearer synthetic-value-123" },
  { timestamp: 1003, level: "info", message: `payload ${syntheticJwt}` },
  { timestamp: 1004, level: "info", message: "Reporter synthetic.person@example.test saw the crash" },
  { timestamp: 1005, level: "info", message: "hotspotPassword=synthetic-hotspot" },
  { timestamp: 1006, level: "info", message: "GET https://storage.example.test/object?X-Amz-Signature=synthetic" },
  { timestamp: 1007, level: "error", message: "uploaded value msk_SYNTHETICSYNTHETIC0001" },
  { timestamp: 1008, level: "<script>", message: "odd level", source: "../../etc" },
  { timestamp: "bad", level: "info", message: "invalid timestamp" },
  { timestamp: 1009, level: "info", message: { nested: true } },
];

describe("occurrence-scoped incident diagnostics", () => {
  const keys = ["CLOUD_REPORT_AGENT_SIGNING_SECRET", "CLOUD_CORE_ENVIRONMENT"] as const;
  let previous: Record<string, string | undefined>;
  const limits = { ...INCIDENT_DIAGNOSTIC_LIMITS };
  beforeEach(() => {
    previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET = secret; process.env.CLOUD_CORE_ENVIRONMENT = "dev";
  });
  afterEach(() => {
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    Object.assign(INCIDENT_DIAGNOSTIC_LIMITS, limits);
  });
  const read = (id = occurrenceId, environment: "dev" | "staging" = "dev") =>
    ({ authorization: `Bearer ${signTestFailureReadGrant(id, environment, Math.floor(Date.now() / 1000) + 300, secret)}` });
  function setup(incidents: Record<string, string[]> = { [occurrenceId]: [assigned], [otherOccurrence]: [unrelated] }) {
    const memory = memoryStore(), runs = runsWith(incidents);
    const app = createTestFailureAgentApi(runs, undefined, new TestFailureIncidentService(runs, memory.store));
    return { ...memory, app, base: `/${occurrenceId}/incidents` };
  }
  type Metadata = { availability: string; logs: { state: string; artifacts: Array<Record<string, any>> };
    omittedArtifacts: Array<{ type: string; reason: string }>; missingEvidence: Array<{ kind: string; reason: string }>; report: any };
  const metadata = async (f: ReturnType<typeof setup>, reportId = assigned) => {
    const response = await f.app.request(`${f.base}/${reportId}`, { headers: read() });
    expect(response.status).toBe(200);
    return await response.json() as Metadata;
  };

  test("only the exact stored incident IDs are queried, with the existing read grant", async () => {
    const f = setup();
    f.add(assigned, {}, []); f.add(unrelated, {}, [{ artifactId: "art_UNRELATED", type: "logs", source: "phone", bytes: bundle(entries) }]);
    const ok = await f.app.request(`${f.base}/${assigned}`, { headers: read() });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    f.calls.length = 0;
    // Another occurrence's incident, an invalid ID and report inventory never reach report storage.
    expect((await f.app.request(`${f.base}/${unrelated}`, { headers: read() })).status).toBe(404);
    expect((await f.app.request(`${f.base}/rep_bad!`, { headers: read() })).status).toBe(400);
    expect((await f.app.request(`${f.base}/${unrelated}/artifacts/art_UNRELATED`, { headers: read() })).status).toBe(404);
    expect((await f.app.request(f.base, { headers: read() })).status).toBe(401);
    expect(f.calls).toEqual([]);
    // Grant scope, method, environment and credential type are unchanged.
    expect((await f.app.request(`${f.base}/${assigned}`, { headers: read(otherOccurrence) })).status).toBe(401);
    expect((await f.app.request(`${f.base}/${assigned}`, { method: "POST", headers: read() })).status).toBe(401);
    expect((await f.app.request(`${f.base}/${assigned}`, { method: "DELETE", headers: read() })).status).toBe(401);
    expect((await f.app.request(`${f.base}/${assigned}`)).status).toBe(401);
    const continuation: ContinuationGrant = { purpose: "mentra-routine-fixer-continuation-v1", environment: "dev", occurrenceId,
      agentRunId: "run_synthetic", executionAttempt: 1, leaseGeneration: 1, leaseTokenSha256: "e".repeat(64),
      candidate: { repository: "Mentra-Community/MentraOS", pullRequest: 1, headSha: "b".repeat(40) },
      routineIds: ["no-glasses"], actions: ["read-results"], expires: Math.floor(Date.now() / 1000) + 300 };
    expect((await f.app.request(`${f.base}/${assigned}`, { headers: { authorization: `Bearer ${signTestContinuationGrant(continuation, secret)}` } })).status).toBe(401);
    process.env.CLOUD_CORE_ENVIRONMENT = "staging";
    expect((await f.app.request(`${f.base}/${assigned}`, { headers: read() })).status).toBe(401);
    expect(f.calls).toEqual([]);
  });

  test("metadata excludes identity, contact, context, filenames and storage; logs are redacted", async () => {
    const f = setup();
    f.add(assigned, { contactEmail: "synthetic.reporter@example.test", feedback: { message: "synthetic private feedback" },
      trigger: { type: "manual", source: "shake", reason: "user report" },
      report: { actualBehavior: "Recording froze; email synthetic.second@example.test", expectedBehavior: "Recording advances",
        contactEmail: "synthetic.reporter@example.test", userSeverity: 3, systemPriority: "high", extra: "synthetic passthrough" },
      context: { settings: { core_token: "synthetic-core-token" }, glasses: { hotspot: { password: "synthetic-hotspot-pw" } } } },
    [{ artifactId: "art_PHONE", type: "logs", source: "phone", bytes: bundle(entries) }]);
    const meta = await metadata(f), text = JSON.stringify(meta);
    for (const value of ["synthetic.reporter@", "synthetic.second@", "mu_synthetic_private", "synthetic-core-token", "synthetic-hotspot",
      "synthetic private feedback", "synthetic passthrough", "synthetic-private-name", "reports/", "storageKey", "context", "contactEmail"])
      expect(text).not.toContain(value);
    expect(meta.report.details).toEqual({ actualBehavior: "Recording froze; email [REDACTED_EMAIL]", expectedBehavior: "Recording advances",
      systemPriority: "high", userSeverity: 3 });
    expect(meta.logs.state).toBe("usable");
    expect(meta.missingEvidence).toEqual([]);
    const body = await (await f.app.request(meta.logs.artifacts[0]!.representation.path.replace("/api/agent/test-failures", ""), { headers: read() })).text();
    for (const value of ["synthetic-value-123", "synthetic-hotspot", syntheticJwt, "eyJ", "synthetic.person@", "X-Amz", "msk_SYNTHETIC", "../", "<script>"])
      expect(body).not.toContain(value);
    const emitted = JSON.parse(body) as { counts: Record<string, number>; entries: Array<{ timestamp: number; level: string; message: string; source?: string }> };
    expect(emitted.counts).toMatchObject({ input: 11, invalid: 2, emitted: 9, redacted: 7, omittedOldest: 0 });
    expect(emitted.entries[0]).toEqual(entries[0] as never);
    expect(emitted.entries[1]!.message).toBe(REDACTED_LINE);
    expect(emitted.entries[4]!.message).toBe("Reporter [REDACTED_EMAIL] saw the crash");
    expect(emitted.entries[8]).toEqual({ timestamp: 1008, level: "unknown", message: "odd level" });
    expect(Object.keys(emitted.entries[0]!).sort()).toEqual(["level", "message", "source", "timestamp"]);
  });

  test("the artifact route emits exactly the bytes whose digest metadata published", async () => {
    const f = setup(); f.add(assigned, {}, [{ artifactId: "art_PHONE", type: "logs", source: "phone", bytes: bundle(entries) }]);
    const described = (await metadata(f)).logs.artifacts[0]!;
    const path = `${f.base}/${assigned}/artifacts/art_PHONE`;
    const first = await f.app.request(path, { headers: read() }), bytes = new Uint8Array(await first.arrayBuffer());
    expect(first.status).toBe(200);
    expect(sha256(bytes)).toBe(described.representation.sha256);
    expect(bytes.byteLength).toBe(described.representation.sizeBytes);
    expect(first.headers.get("etag")).toBe(`"${described.representation.sha256}"`);
    expect(first.headers.get("x-mentra-representation-sha256")).toBe(described.representation.sha256);
    expect(first.headers.get("repr-digest")).toBe(`sha-256=:${Buffer.from(described.representation.sha256, "hex").toString("base64")}:`);
    expect(first.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(first.headers.get("x-content-type-options")).toBe("nosniff");
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(first.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(JSON.parse(new TextDecoder().decode(bytes)).sourceSha256).toBe(sha256(bundle(entries)));
    expect(sha256(new Uint8Array(await (await f.app.request(path, { headers: read() })).arrayBuffer()))).toBe(described.representation.sha256);
    const head = await f.app.request(path, { method: "HEAD", headers: read() });
    expect(head.status).toBe(200); expect(head.headers.get("etag")).toBe(first.headers.get("etag"));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    // A stored payload that no longer matches its recorded digest is not projected.
    f.reports.get(assigned)!.artifacts[0]!.recordedSha256 = "0".repeat(64);
    expect((await metadata(f)).logs.artifacts[0]).toMatchObject({ state: "unreadable" });
    expect((await f.app.request(path, { headers: read() })).status).toBe(409);
  });

  test("artifacts from another incident, screenshots and state snapshots are not addressable", async () => {
    const f = setup({ [occurrenceId]: [assigned, unrelated] });
    f.add(assigned, {}, [{ artifactId: "art_SHOT", type: "screenshot", source: "phone", contentType: "image/png", bytes: Buffer.from("png") },
      { artifactId: "art_STATE", type: "state_snapshot", source: "phone", bytes: Buffer.from("{}") }]);
    f.add(unrelated, {}, [{ artifactId: "art_OTHER", type: "logs", source: "phone", bytes: bundle(entries) }]);
    const meta = await metadata(f);
    expect(meta.logs.state).toBe("missing");
    expect(meta.omittedArtifacts.map(item => item.type)).toEqual(["screenshot", "state_snapshot"]);
    expect(meta.omittedArtifacts[0]!.reason).toContain("occurrence assets route");
    expect(meta.missingEvidence.map(item => item.kind)).toEqual(["phone-logs"]);
    f.calls.length = 0;
    for (const artifact of ["art_OTHER", "art_SHOT", "art_STATE"])
      expect((await f.app.request(`${f.base}/${assigned}/artifacts/${artifact}`, { headers: read() })).status).toBe(404);
    expect((await f.app.request(`${f.base}/${assigned}/artifacts/..%2Fart_OTHER`, { headers: read() })).status).toBe(400);
    expect(f.calls.filter(call => call.startsWith("read:"))).toEqual([]);
    expect((await f.app.request(`${f.base}/${unrelated}/artifacts/art_OTHER`, { headers: read() })).status).toBe(200);
  });

  test("missing and collecting incidents never look like usable or complete evidence", async () => {
    const f = setup({ [occurrenceId]: ["rep_01A", "rep_01B", "rep_01C", "rep_01D", "rep_01E"] });
    const missing = await metadata(f, "rep_01A");
    expect(missing).toMatchObject({ availability: "missing", report: null, logs: { state: "missing" } });
    expect(missing.missingEvidence[0]!.kind).toBe("incident");
    expect((await f.app.request(`${f.base}/rep_01A/artifacts/art_ANY`, { headers: read() })).status).toBe(404);
    f.add("rep_01B", { status: "collecting" }, []);
    const collecting = await metadata(f, "rep_01B");
    expect(collecting.logs.state).toBe("collecting");
    expect(collecting.missingEvidence.map(item => item.kind)).toEqual(["incident", "phone-logs"]);
    f.add("rep_01C", { status: "collecting" }, [{ artifactId: "art_PHONE", type: "logs", source: "phone", bytes: bundle(entries) }]);
    const partial = await metadata(f, "rep_01C");
    expect(partial.logs.state).toBe("usable");
    expect(partial.missingEvidence.map(item => item.kind)).toEqual(["incident"]);
    f.add("rep_01D", {}, [{ artifactId: "art_GLASSES", type: "logs", source: "glasses", bytes: bundle(entries) }]);
    expect((await metadata(f, "rep_01D")).missingEvidence.map(item => item.kind)).toEqual(["phone-logs"]);
    f.add("rep_01E", {}, [{ artifactId: "art_EMPTY", type: "logs", source: "phone", bytes: bundle([]) }]);
    const empty = await metadata(f, "rep_01E");
    expect(empty.logs).toMatchObject({ state: "unreadable", artifacts: [{ state: "empty" }] });
    for (const value of [missing, collecting, partial, empty]) {
      expect(JSON.stringify(value)).not.toContain("\"complete\"");
      expect(value).not.toHaveProperty("outcome");
    }
  });

  test("malformed, deep, unsupported, missing and oversized payloads are distinguished and bounded", async () => {
    const f = setup();
    INCIDENT_DIAGNOSTIC_LIMITS.maxSourceLogBytes = 4096;
    const deep = Buffer.from(`{"entries":[{"timestamp":1,"level":"info","message":"x","extra":${"[".repeat(12)}${"]".repeat(12)}}]}`);
    f.add(assigned, {}, [
      { artifactId: "art_NOTJSON", type: "logs", source: "phone", bytes: Buffer.from("not json") },
      { artifactId: "art_BINARY", type: "logs", source: "phone", bytes: Buffer.from([0xff, 0xfe, 0x00]) },
      { artifactId: "art_DEEP", type: "logs", source: "phone", bytes: deep },
      { artifactId: "art_SHAPE", type: "logs", source: "phone", bytes: Buffer.from(JSON.stringify({ logs: [] })) },
      { artifactId: "art_TEXT", type: "logs", source: "phone", contentType: "text/plain", bytes: Buffer.from("plain") },
      { artifactId: "art_NOROW", type: "logs", source: "phone", bytes: bundle(entries), assetMissing: true },
      { artifactId: "art_HUGE", type: "logs", source: "phone", bytes: Buffer.alloc(8192, 0x20) },
      { artifactId: "art_BLOB", type: "logs", source: "phone" },
      { artifactId: "art_NINTH", type: "logs", source: "phone", bytes: bundle(entries) },
    ]);
    const meta = await metadata(f);
    expect(meta.logs.state).toBe("unreadable");
    expect(meta.logs.artifacts.map(item => [item.artifactId, item.state])).toEqual([["art_NOTJSON", "unreadable"], ["art_BINARY", "unreadable"],
      ["art_DEEP", "unreadable"], ["art_SHAPE", "unreadable"], ["art_TEXT", "unsupported"], ["art_NOROW", "asset-missing"],
      ["art_HUGE", "oversized"], ["art_BLOB", "unreadable"], ["art_NINTH", "over-limit"]]);
    expect(meta.logs.artifacts.every(item => typeof item.reason === "string" && !item.representation)).toBe(true);
    // Oversized and over-limit payloads are rejected from metadata without reading them.
    expect(f.calls).not.toContain(`read:${assigned}/art_HUGE`); expect(f.calls).not.toContain(`read:${assigned}/art_NINTH`);
    const status = async (artifact: string) => (await f.app.request(`${f.base}/${assigned}/artifacts/${artifact}`, { headers: read() })).status;
    expect(await status("art_NOTJSON")).toBe(409); expect(await status("art_HUGE")).toBe(413);
    expect(await status("art_TEXT")).toBe(404); expect(await status("art_NOROW")).toBe(404); expect(await status("art_NINTH")).toBe(404);
  });

  test("entry count, message length and emitted bytes are bounded, keeping the newest entries", async () => {
    const f = setup();
    Object.assign(INCIDENT_DIAGNOSTIC_LIMITS, { maxEntries: 50, maxMessageChars: 40, maxEmittedBytes: 4096 });
    const many = Array.from({ length: 200 }, (_, index) => ({ timestamp: index, level: "info", message: `frame ${index} ${"x".repeat(80)}` }));
    f.add(assigned, {}, [{ artifactId: "art_MANY", type: "logs", source: "phone", bytes: bundle(many) }]);
    const described = (await metadata(f)).logs.artifacts[0]!;
    const response = await f.app.request(`${f.base}/${assigned}/artifacts/art_MANY`, { headers: read() });
    const bytes = new Uint8Array(await response.arrayBuffer()), emitted = JSON.parse(new TextDecoder().decode(bytes));
    expect(bytes.byteLength).toBeLessThanOrEqual(4096);
    expect(emitted.entries.length).toBeLessThanOrEqual(50);
    expect(emitted.entries.at(-1).timestamp).toBe(199);
    // Overlong messages are replaced wholesale, never truncated to a prefix.
    const first = 200 - emitted.entries.length;
    expect(emitted.entries[0].message).toBe(omittedTextMarker(`frame ${first} `.length + 80, 40));
    expect(body(bytes)).not.toContain("xxx");
    expect(emitted.counts).toMatchObject({ input: 200, emitted: emitted.entries.length, omittedOldest: 200 - emitted.entries.length,
      omittedMessages: emitted.entries.length });
    expect(described.counts).toEqual(emitted.counts);
    expect(sha256(bytes)).toBe(described.representation.sha256);
  });

  test("a near-maximum adversarial bundle is reviewed linearly and identically on metadata, GET and HEAD", async () => {
    const f = setup(), limits = INCIDENT_DIAGNOSTIC_LIMITS, credential = "msk_SYNTHETICTAIL1234567890";
    const second = "frame ".repeat(Math.floor(128 * 1024 / 6)) + `password=${credential}`;
    const tail = [
      { timestamp: 2_000_000_001, level: "info", message: `${"x".repeat(64 * 1024)} ${credential}`, source: "phone" },
      { timestamp: 2_000_000_002, level: "warn", message: second },
      { timestamp: 2_000_000_003, level: "i".repeat(1024 * 1024), message: "long level", source: "s".repeat(1024 * 1024) },
      { timestamp: 2_000_000_004, level: "info", message: `upload ${"q".repeat(300)}${credential} done`, source: "phone" },
      { timestamp: 2_000_000_005, level: "info", message: "ScreenRecorder frame pts 4.000s did not advance", source: "phone" },
    ];
    // Filler: thousands of maximum-length malformed JWT, email and URL strings.
    const raw = nearMaximumBundle(ADVERSARIAL.map(item => item.value), tail);
    f.add(assigned, { createdAt: "9".repeat(64 * 1024),
      trigger: { type: "manual", source: "shake", reason: `${"r".repeat(128 * 1024)}${credential}` },
      report: { actualBehavior: `${"a ".repeat(32 * 1024)}${credential}`, expectedBehavior: "Recording advances" } },
    [{ artifactId: "art_MAX", type: "logs", source: "phone", bytes: raw }]);
    const path = `${f.base}/${assigned}/artifacts/art_MAX`;

    const started = performance.now();
    const { result: [meta, get, head], longestPattern, longestTransform } = await observedAsync(async () => {
      const described = await metadata(f);
      const response = await f.app.request(path, { headers: read() });
      const bytes = new Uint8Array(await response.arrayBuffer());
      return [described, { status: response.status, bytes }, await f.app.request(path, { method: "HEAD", headers: read() })] as const;
    });
    const elapsed = performance.now() - started;
    // Structural: regular expressions only see routing input and short labels, never message text,
    // and no transform sees more than one bounded string.
    expect(longestPattern).toBeLessThan(limits.maxMessageChars / 4);
    expect(longestTransform).toBeLessThanOrEqual(limits.maxMessageChars);
    // Generous backstop only; correctness does not depend on timing.
    expect(elapsed).toBeLessThan(20_000);

    const described = meta.logs.artifacts[0]!, text = body(get.bytes), emitted = JSON.parse(text);
    expect(get.status).toBe(200); expect(head.status).toBe(200);
    expect(described.state).toBe("usable");
    expect(sha256(get.bytes)).toBe(described.representation.sha256);
    expect(head.headers.get("etag")).toBe(`"${described.representation.sha256}"`);
    expect(described.counts).toEqual(emitted.counts);
    const identity = { reportId: assigned, artifactId: "art_MAX", source: "phone", sourceSha256: sha256(raw) };
    const again = projectIncidentLog(raw, identity);
    expect("bytes" in again && again.sha256).toBe(described.representation.sha256);

    for (const leaked of [credential, "xxxxxxxxxx", "frame frame", "qqqqqqqqqq", "iiiiiiiiii", "ssssssssss", "rrrrrrrrrr", "9999999999"]) {
      expect(text).not.toContain(leaked); expect(JSON.stringify(meta)).not.toContain(leaked);
    }
    expect(emitted.entries.slice(-tail.length)).toEqual([
      { timestamp: 2_000_000_001, level: "info", message: omittedTextMarker(64 * 1024 + 1 + credential.length, limits.maxMessageChars), source: "phone" },
      { timestamp: 2_000_000_002, level: "warn", message: omittedTextMarker(second.length, limits.maxMessageChars) },
      { timestamp: 2_000_000_003, level: "unknown", message: "long level" },
      // An unbroken run is reviewed whole: its credential makes the message credential-bearing.
      { timestamp: 2_000_000_004, level: "info", message: REDACTED_LINE, source: "phone" },
      tail[4],
    ]);
    expect(emitted.counts).toMatchObject({ omittedMessages: 2, unknownLevels: 1, rejectedSources: 1 });
    // The existing entry and emitted-byte bounds, not the 16 MiB source, bound how many entries were reviewed.
    expect(emitted.counts.emitted).toBeLessThanOrEqual(limits.maxEntries);
    expect(get.bytes.byteLength).toBeLessThanOrEqual(limits.maxEmittedBytes);
    expect(emitted.counts.omittedOldest).toBeGreaterThan(0);
    expect(emitted.counts.input).toBe(emitted.counts.emitted + emitted.counts.omittedOldest);
    // Every adversarial filler got its documented result.
    for (const entry of emitted.entries.slice(0, -tail.length) as Array<{ timestamp: number; message: string }>) {
      const filler = ADVERSARIAL[entry.timestamp % ADVERSARIAL.length]!;
      expect(entry.message).toBe(filler.expected === "redacted" ? REDACTED_LINE : filler.expected === "masked" ? REDACTED_EMAIL : filler.value);
    }

    expect(meta.report.createdAt).toBeNull();
    expect(meta.report.trigger).toEqual({ type: "manual", source: "shake", sourceAppletPackageName: null,
      reason: omittedTextMarker(128 * 1024 + credential.length, 500) });
    expect(meta.report.details).toMatchObject({ expectedBehavior: "Recording advances",
      actualBehavior: omittedTextMarker(64 * 1024 + credential.length, limits.maxFieldChars) });
  }, 60_000);
});

describe("secondary diagnostic fields use the reviewed guard", () => {
  // Synthetic credential-shaped labels; none is a real credential.
  const credentialSources = ["msk_SYNTHETIC123456789012", "session_cookie", "clientSecret", "AuthTokenStore", "x-api-key",
    "ghp_" + "S1".repeat(10), "blob" + "Qx7".repeat(12)];
  const normalSources = ["phone", "glasses", "com.mentra.merge", "K900BluetoothManager", "MentraLive.ScreenRecorder", "asg:camera"];
  const decode = (projection: ReturnType<typeof projectIncidentLog>) => {
    if (!("bytes" in projection)) throw new Error(`unexpected ${projection.state}`);
    return { text: new TextDecoder().decode(projection.bytes), json: JSON.parse(new TextDecoder().decode(projection.bytes)) };
  };

  test("a credential-shaped source and a secret-word level are not forwarded verbatim", () => {
    const source = "msk_SYNTHETIC123456789012";
    const { text, json } = decode(projectIncidentLog(bundle([{ timestamp: 1, level: "password", message: "Recorder frame did not advance", source }]),
      { reportId: "rep_01SYNTHETIC", artifactId: "art_01SYNTHETIC", source, sourceSha256: "0".repeat(64) }));
    expect(text).not.toContain("msk_SYNTHETIC"); expect(text).not.toContain("password");
    expect(json.source).toBe("unknown");
    expect(json.entries).toEqual([{ timestamp: 1, level: "unknown", message: "Recorder frame did not advance" }]);
    expect(json.counts).toMatchObject({ unknownLevels: 1, rejectedSources: 1, redacted: 0 });
  });

  test("entry sources: credential/cookie/secret labels are dropped, normal sources and package names remain", () => {
    const input = [...credentialSources, ...normalSources, "../../etc", "a b"].map((source, index) => ({ timestamp: index, level: "info", message: "frame", source }));
    const { text, json } = decode(projectIncidentLog(bundle(input), { reportId: "rep_01S", artifactId: "art_01S", source: "phone", sourceSha256: "0".repeat(64) }));
    for (const value of credentialSources) expect(text).not.toContain(value);
    expect(json.entries.map((entry: { source?: string }) => entry.source ?? null))
      .toEqual([...credentialSources.map(() => null), ...normalSources, null, null]);
    expect(json.counts).toMatchObject({ rejectedSources: credentialSources.length + 2, redacted: 0, emitted: input.length });
    for (const value of normalSources) expect(sourceLabel(value)).toBe(value);
    for (const value of credentialSources) expect(sourceLabel(value)).toBeNull();
  });

  test("levels outside the explicit set become unknown; known levels are normalized", () => {
    const levels = ["INFO", "Warn", "warning", "debug", "error", "fatal", "log", "verbose", "trace", "password", "token", "Custom", "e", "<script>"];
    const { json } = decode(projectIncidentLog(bundle(levels.map((level, index) => ({ timestamp: index, level, message: "m" }))),
      { reportId: "rep_01S", artifactId: "art_01S", source: "glasses", sourceSha256: "0".repeat(64) }));
    expect(json.entries.map((entry: { level: string }) => entry.level)).toEqual(["info", "warn", "warning", "debug", "error", "fatal", "log",
      "verbose", "trace", "unknown", "unknown", "unknown", "unknown", "unknown"]);
    expect(json.counts.unknownLevels).toBe(5);
    expect(logLevel("SECRET")).toBe("unknown");
  });

  test("metadata artifact sources, types, IDs and report enums pass the same guard", async () => {
    const memory = memoryStore(), runs = runsWith({ [occurrenceId]: [assigned] });
    const service = new TestFailureIncidentService(runs, memory.store);
    const log = (artifactId: string, source: string) => ({ artifactId, type: "logs" as const, source, bytes: bundle(entries.slice(0, 1)) });
    memory.add(assigned, { kind: "password", status: "token_synthetic" }, [
      log("art_CRED", "msk_SYNTHETIC123456789012"),
      { artifactId: "art_SHOT", type: "screenshot", source: "session_cookie", contentType: "image/png", bytes: Buffer.from("png") },
      { artifactId: "art_STATE", type: "state_snapshot", source: "clientSecret", bytes: Buffer.from("{}") },
      { artifactId: "art_ODD", type: "secret_type" as never, source: "phone", bytes: Buffer.from("{}") },
      log("msk_SYNTHETIC123456789012", "phone"),
      log("art_PHONE", "phone"), log("art_GLASSES", "glasses"), log("art_PKG", "com.mentra.merge"),
    ]);
    const meta = await service.metadata(occurrenceId, assigned, "/base") as Record<string, any>;
    const text = JSON.stringify(meta);
    for (const value of ["msk_SYNTHETIC", "session_cookie", "clientSecret", "secret_type", "password", "token_synthetic"])
      expect(text).not.toContain(value);
    expect(meta.report).toMatchObject({ kind: "unknown", status: "unknown" });
    expect(meta.logs.artifacts.map((item: Record<string, unknown>) => [item.artifactId, item.source, item.state])).toEqual([
      ["art_CRED", "unknown", "usable"], ["art_PHONE", "phone", "usable"], ["art_GLASSES", "glasses", "usable"], ["art_PKG", "com.mentra.merge", "usable"]]);
    expect(meta.omittedArtifacts.map((item: Record<string, unknown>) => [item.artifactId, item.type, item.source])).toEqual([
      ["art_SHOT", "screenshot", "unknown"], ["art_STATE", "state_snapshot", "unknown"], ["art_ODD", "unknown", "phone"], [null, "logs", "phone"]]);
    expect(meta.omittedArtifacts[3].reason).toContain("not a reviewed diagnostic ID");
    // The emitted representation carries the same reviewed source label, and an unreviewed ID is not addressable.
    const response = await service.artifact(occurrenceId, assigned, "art_CRED", new Request("http://core.test/x"));
    const body = await response.text();
    expect(body).not.toContain("msk_SYNTHETIC"); expect(JSON.parse(body).source).toBe("unknown");
    await expect(service.artifact(occurrenceId, assigned, "msk_SYNTHETIC123456789012", new Request("http://core.test/x"))).rejects.toThrow("invalid artifactId");
  });
});

describe("input bounds precede review, and review is linear", () => {
  const credential = "msk_SYNTHETICTAIL1234567890", max = maxChars;

  test("the observers see strings given to patterns and transforms, and character reads", () => {
    expect(observed(() => "a".repeat(5000).replace(/b/g, "")).longestPattern).toBe(5000);
    expect(observed(() => /c/.test("d".repeat(4000))).patternCalls).toBeGreaterThan(0);
    expect(observed(() => "e".repeat(3000).split(/,/)).longestPattern).toBe(3000);
    expect(observed(() => "F".repeat(2500).toLowerCase()).longestTransform).toBe(2500);
    const runtime = "a".repeat(3); // not a literal, which the transpiler may fold
    expect(countScans(() => runtime.charCodeAt(1) + Number(runtime.startsWith("a"))).scans).toBe(2);
  });

  for (const size of [64 * 1024, 128 * 1024]) test(`a ${size / 1024} KiB message with a credential tail is omitted before anything reads it`, () => {
    for (const unit of ["a", "eyJ", "a%", "a.@", "b:", "a://", "frame "]) {
      const value = `${unit.repeat(size).slice(0, size - credential.length - 1)} ${credential}`;
      expect(value.length).toBe(size);
      const { result, longest, patternCalls } = observed(() => redactDiagnosticText(value));
      expect([longest, patternCalls]).toEqual([0, 0]);
      expect(countScans(() => redactDiagnosticText(value)).scans).toBe(0);
      expect(result).toEqual({ text: omittedTextMarker(size, max), redacted: false, omitted: true });
    }
  });

  test("maximum-length malformed JWT, email and URL strings are reviewed linearly, without regular expressions", () => {
    for (const { name, value, expected } of ADVERSARIAL) {
      expect(value.length).toBe(max);
      const { result, patternCalls, longestTransform } = observed(() => redactDiagnosticText(value));
      const text = expected === "redacted" ? REDACTED_LINE : expected === "masked" ? REDACTED_EMAIL : value;
      // Only candidate secret words (13 characters at most) are case-folded.
      expect({ name, patternCalls, folded: longestTransform <= 13, text: result.text }).toEqual({ name, patternCalls: 0, folded: true, text });
      // A constant number of reads per character; rescanning the run from each start would need ~1000.
      const { scans } = countScans(() => redactDiagnosticText(value));
      expect({ name, linear: scans <= 64 * value.length }).toEqual({ name, linear: true });
    }
  });

  test("intentional over-redaction is limited to whole email tokens and credential-like lines", () => {
    for (const [value, text] of [
      // A JWT-like header prefix is enough; no dot-separated payload is required.
      [`config ${base64url(JSON.stringify({ synthetic: true }))}`, REDACTED_LINE],
      // URL userinfo without a password.
      ["GET https://synthetic@example.test/status", REDACTED_LINE],
      // An armour line without its BEGIN label.
      ["armour PRIVATE KEY----- line", REDACTED_LINE],
      // A whole email-like token, including surrounding punctuation and package specifiers.
      ["reporter <synthetic.person@example.test>, retrying", `reporter ${REDACTED_EMAIL} retrying`],
      ["installed miniapp@1.2.3 ok", `installed ${REDACTED_EMAIL} ok`],
      // Not email- or credential-like.
      ["@Override onCreate", "@Override onCreate"],
      ["import @mentra/miniapp", "import @mentra/miniapp"],
      ["https://example.test/users/@synthetic", "https://example.test/users/@synthetic"],
      ["ratio 3:2 at 10:30", "ratio 3:2 at 10:30"],
    ]) expect(redactDiagnosticText(value!).text).toBe(text!);
  });

  test("the bound precedes review: a message at the bound ending in a credential is still redacted", () => {
    const atBound = `${"frame ".repeat(max).slice(0, max - credential.length - 1)} ${credential}`;
    expect(atBound.length).toBe(max);
    expect(redactDiagnosticText(atBound)).toMatchObject({ text: REDACTED_LINE, redacted: true, omitted: false });
    expect(redactDiagnosticText(`${atBound} `)).toMatchObject({ text: omittedTextMarker(max + 1, max), omitted: true, redacted: false });
  });

  test("long unbroken runs within the bound are reviewed whole", () => {
    expect(redactDiagnosticText(`upload ${"q".repeat(300)}${credential} done`)).toEqual({ text: REDACTED_LINE, redacted: true, omitted: false });
    expect(redactDiagnosticText(`Authorization: Bearer ${"Z9".repeat(200)}`)).toMatchObject({ text: REDACTED_LINE, redacted: true });
    const kept = `status ${"k".repeat(max - 7)}`;
    expect(redactDiagnosticText(kept)).toEqual({ text: kept, redacted: false, omitted: false });
  });

  test("levels and source labels are length-checked before any inspection", () => {
    const { result, longest } = observed(() => [logLevel("info".repeat(256 * 1024)), sourceLabel("phone".repeat(200 * 1024))]);
    expect(result).toEqual(["unknown", null]);
    expect(longest).toBe(0);
  });

  test("typical logs keep their newest maxEntries entries", () => {
    const typical = Array.from({ length: 6000 }, (_, index) => ({ timestamp: index, level: "info", source: "com.mentra.merge",
      message: `ScreenRecorder frame ${index} pts ${(index / 30).toFixed(3)}s advanced; com.mentra.screen_recorder.ScreenRecorderModule queue=3 `
        + `GET https://api.example.test/v1/status?frame=${index} 200` }));
    const projection = projectIncidentLog(bundle(typical), { reportId: "rep_01S", artifactId: "art_01S", source: "phone", sourceSha256: "0".repeat(64) });
    if (!("bytes" in projection)) throw new Error(projection.state);
    const json = JSON.parse(body(projection.bytes));
    expect(json.counts).toMatchObject({ input: 6000, emitted: 5000, omittedOldest: 1000, omittedMessages: 0, redacted: 0 });
    expect(json.entries.at(-1)).toEqual(typical.at(-1));
  });
});

test("redaction replaces credential-bearing text and masks contact data but keeps diagnostic identifiers", () => {
  for (const value of ["core_token=abc", "Bearer abc", "set apiKey", "Cookie: a=b", "password reset", "sk-" + "a1".repeat(10),
    "https://user:pw@example.test/", "sk_" + "b2".repeat(8), "ghp_" + "A1".repeat(10), "blob " + "Qx7".repeat(12), `jwt-shaped ${syntheticJwt}`,
    "xoxb-" + "c3".repeat(6), "AKIA" + "D4".repeat(6), ["-----BEGIN RSA", "PRIVATE KEY-----"].join(" "), "X-Amz-Signature=synthetic"])
    expect(redactDiagnosticText(value)).toMatchObject({ text: REDACTED_LINE, redacted: true });
  for (const value of ["commit " + "a".repeat(40), "request 123e4567-e89b-12d3-a456-426614174000", "keyboard shown", "authentication screen",
    "com.mentra.screen_recorder.ScreenRecorderModule started", "task-abcdefghijklmnop finished", "task-sk-abc finished"])
    expect(redactDiagnosticText(value)).toEqual({ text: value, redacted: false, omitted: false });
});

describe("the linear review is at least as conservative as the patterns it replaced", () => {
  // Reference oracle: the regular expressions used before this review became linear. They are run
  // here only on short generated strings, where their backtracking is harmless.
  const legacyWords = new Set(["token", "tokens", "password", "passwords", "passwd", "pwd", "secret", "secrets", "auth", "bearer", "key",
    "keys", "apikey", "authorization", "cookie", "cookies", "credential", "credentials", "signature", "sig", "jwt", "otp", "passcode"]);
  const legacyShapes = [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
    /(?<![A-Za-z0-9])(?:msk_|sk-|sk_|rk_|ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|xox[aboprs]-|AKIA|ASIA)[A-Za-z0-9_-]{10,}/,
    /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
  const legacyEmail = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const legacyCredential = (value: string) =>
    value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).some(word => legacyWords.has(word.toLowerCase()))
    || (value.match(/[A-Za-z0-9+=_-]{32,}/g) ?? []).some(run => !/^[0-9a-fA-F-]+$/.test(run) && /[0-9]/.test(run) && /[A-Za-z]/.test(run)
      && !/^[A-Za-z_-]+[0-9]{0,4}$/.test(run))
    || legacyShapes.some(pattern => pattern.test(value));

  test("every string the earlier patterns redacted or masked is still redacted or masked", () => {
    const mixed = ["eyJ", "hbGciOiJ", "a", "Z", "9", "1234", "12345", ".", "@", ":", "://", "/", "-", "_", "+", "=", "%", " ", "\t", " ",
      "msk_", "sk-", "sk_", "rk_", "xoxb-", "AKIA", "ghp_", "github_pat_", "https", "user", "pw", "example", "test", "com", "PRIVATE KEY-----",
      "-----BEGIN ", "RSA ", "Token", "auth", "aB", "Qx7", "Qx7".repeat(11), "deadbeef".repeat(5), "abcdefghijklmnopqrstuvwxyzabcdef12"];
    // Mostly email-shaped pieces, so that many samples carry an email but no credential.
    const contact = ["a", "Z", "9", ".", ".", "@", "@", "-", "_", "+", "%", " ", "\t", " ", "<", ">", ",", "/", ":", "://", "https",
      "synthetic", "person", "example", "test", "com", "io", "x", "person@", "@example", ".test", ".io"];
    let seed = 0x5eed;
    const next = () => { // mulberry32: deterministic, so any failure reproduces exactly
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const failures: string[] = [];
    let credentials = 0, emails = 0;
    for (let sample = 0; sample < 40_000; sample++) {
      const pieces = sample % 2 ? contact : mixed;
      let value = "";
      for (let count = 1 + Math.floor(next() * 16); count > 0; count--) value += pieces[Math.floor(next() * pieces.length)];
      const reviewed = redactDiagnosticText(value);
      if (legacyCredential(value)) {
        credentials++;
        if (reviewed.text !== REDACTED_LINE) failures.push(`credential kept: ${JSON.stringify(value)}`);
        continue;
      }
      for (const match of value.match(legacyEmail) ?? []) {
        emails++;
        if (reviewed.text.includes(match)) failures.push(`email kept: ${JSON.stringify(value)}`);
      }
    }
    expect(failures.slice(0, 5)).toEqual([]);
    // The generator exercises both paths substantially.
    expect(credentials).toBeGreaterThan(5000);
    expect(emails).toBeGreaterThan(500);
  });
});
