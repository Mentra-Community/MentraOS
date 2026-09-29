/**
 * Occurrence-scoped incident diagnostics for the routine fixer.
 *
 * A failure occurrence may name incident reports (`failure.incidentIds`). This
 * service lets a holder of that occurrence's existing read capability retrieve
 * a reviewed, bounded representation of exactly those reports. It never lists
 * reports, accepts arbitrary report IDs, or returns raw artifact bytes.
 *
 * The representation is deliberately narrow:
 * - report metadata excludes account identity, contact data, feedback, raw
 *   context/state snapshots, filenames and storage keys;
 * - only JSON log bundles (`{entries: [{timestamp, level, message, source}]}`)
 *   are projected, with credential-bearing lines replaced wholesale;
 * - secondary fields (artifact and entry sources, levels, artifact types/IDs,
 *   report kind/status) are free strings upstream, so they pass the same
 *   credential guard or an explicit allowed set, and are otherwise dropped or
 *   normalized to `unknown`; freeform report text uses the message guard;
 * - every string is length-checked before any other inspection: overlong text
 *   is replaced wholesale by a marker (never truncated). Bounded text is then
 *   reviewed by explicit single-pass scans with constant work per character,
 *   so a projection costs at most maxEntries × maxMessageChars scanned
 *   characters on metadata, GET and HEAD alike;
 * - screenshots, state snapshots and unknown formats are omitted with reasons.
 *
 * Redaction is best-effort pattern matching over short strings. It does not
 * make arbitrary blobs or unrecognised secret formats safe, and a JSON entry
 * shape does not imply its contents are harmless; that is why no other format
 * is forwarded and every forwarded string goes through a reviewed guard.
 * Incident availability never changes the failure outcome or its evidence
 * completeness: an incident ID does not prove anything was uploaded.
 */

import { createHash } from "node:crypto";
import { getReport, readReportArtifactPayload } from "./report.service";
import { TestRunError, type TestRunService } from "./test-run.service";

export const INCIDENT_DIAGNOSTIC_REDACTION_POLICY = "core-incident-log-redaction-v1";
const LOG_REPRESENTATION = "mentra-incident-log-entries-v1";
const REPRESENTATION_CONTENT_TYPE = "application/json; charset=utf-8";

/** Bounds on reads, on reviewed text and on emitted bytes. Exported for tests only. */
export const INCIDENT_DIAGNOSTIC_LIMITS = {
  maxListedArtifacts: 50,
  maxLogArtifacts: 8,
  maxSourceLogBytes: 16 * 1024 * 1024,
  maxJsonDepth: 8,
  maxEntries: 5000,
  maxMessageChars: 2000,
  maxEmittedBytes: 2 * 1024 * 1024,
  maxFieldChars: 2000,
};

const reportIdPattern = /^rep_[A-Za-z0-9]{1,80}$/;
const artifactIdPattern = /^art_[A-Za-z0-9]{1,80}$/;

export interface IncidentReportStore {
  getReport: typeof getReport;
  readReportArtifactPayload: typeof readReportArtifactPayload;
}
const defaultStore: IncidentReportStore = { getReport, readReportArtifactPayload };
type Runs = Pick<TestRunService, "failureDetail">;
type StoredReport = NonNullable<Awaited<ReturnType<typeof getReport>>>;
type MissingKind = "phone-logs" | "glasses-logs" | "incident" | "other";
type LogState = "usable" | "empty" | "unreadable" | "oversized" | "unsupported" | "asset-missing" | "over-limit";

// ── Redaction ────────────────────────────────────────────────────────────────
// Same policy as the Mentra App's MentraJSLogPipeline.redactSecrets: a string
// that mentions a secret-like word is replaced entirely (over-redaction is
// preferred to leaking). Words are compared after splitting on punctuation,
// underscores and camelCase so `authToken`, `core_token` and
// `X-Amz-Signature` are also caught. Known credential shapes are redacted too.
//
// No regular expression inspects freeform text. Each check below is one
// left-to-right scan that does a constant amount of work per character
// (fixed-length prefix comparisons, a lookahead of at most 10 characters),
// so reviewing a string costs time linear in its length whatever its shape.
// Every check matches at least what the earlier regular expressions matched,
// and some match more (see the comments); omitting more text is intended.
const SECRET_WORDS = new Set(["token", "tokens", "password", "passwords", "passwd", "pwd", "secret", "secrets", "auth",
  "bearer", "key", "keys", "apikey", "authorization", "cookie", "cookies", "credential", "credentials", "signature",
  "sig", "jwt", "otp", "passcode"]);
const LONGEST_SECRET_WORD = Math.max(...[...SECRET_WORDS].map(word => word.length));
const CREDENTIAL_PREFIXES = ["msk_", "sk-", "sk_", "rk_", "ghp_", "gho_", "ghs_", "ghu_", "ghr_", "github_pat_",
  "xoxa-", "xoxb-", "xoxo-", "xoxp-", "xoxr-", "xoxs-", "AKIA", "ASIA"];
/** Prefixes by first character code, so each position compares only the prefixes that can start there. */
const PREFIXES_BY_FIRST_CHAR = new Map<number, string[]>();
for (const prefix of CREDENTIAL_PREFIXES)
  PREFIXES_BY_FIRST_CHAR.set(prefix.charCodeAt(0), [...PREFIXES_BY_FIRST_CHAR.get(prefix.charCodeAt(0)) ?? [], prefix]);
const JWT_PREFIX = "eyJ"; // base64url of `{"`
const PRIVATE_KEY_MARKER = "PRIVATE KEY-----";
const OPAQUE_RUN_CHARS = 32;
export const REDACTED_LINE = "[REDACTED: credential-bearing text]";
export const REDACTED_EMAIL = "[REDACTED_EMAIL]";

const isDigit = (code: number) => code >= 48 && code <= 57;
const isUpper = (code: number) => code >= 65 && code <= 90;
const isLower = (code: number) => code >= 97 && code <= 122;
const isAlnum = (code: number) => isDigit(code) || isUpper(code) || isLower(code);
const isHexLetter = (code: number) => (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
/** `[A-Za-z0-9_-]`, the base64url/token alphabet. */
const isTokenChar = (code: number) => isAlnum(code) || code === 95 || code === 45;
/** ASCII whitespace. Treating other separators as token characters only widens tokens, which is conservative here. */
const isSpace = (code: number) => code === 32 || (code >= 9 && code <= 13);
/** `[A-Za-z0-9._%+-]`, an email local-part character. */
const isLocalChar = (code: number) => isTokenChar(code) || code === 46 || code === 37 || code === 43;

/** Whether `count` token characters follow `start`; reads at most `count` characters. */
function tokenCharsFollow(text: string, start: number, count: number): boolean {
  if (start + count > text.length) return false;
  for (let index = start; index < start + count; index++) if (!isTokenChar(text.charCodeAt(index))) return false;
  return true;
}

/** Secret words, split on non-alphanumerics and at lower/digit→upper (camelCase) boundaries. */
function mentionsSecretWord(text: string): boolean {
  let start = 0;
  for (let index = 0; index <= text.length; index++) {
    const code = index < text.length ? text.charCodeAt(index) : 32;
    const camel = isUpper(code) && index > 0 && (isLower(text.charCodeAt(index - 1)) || isDigit(text.charCodeAt(index - 1)));
    if (isAlnum(code) && !camel) continue;
    // Words longer than every secret word cannot match, so only short slices are compared.
    if (index > start && index - start <= LONGEST_SECRET_WORD && SECRET_WORDS.has(text.slice(start, index).toLowerCase())) return true;
    start = camel ? index : index + 1;
  }
  return false;
}

/**
 * Known credential shapes, checked with fixed-length comparisons at each position:
 * - a vendor prefix at a word start followed by 10+ token characters;
 * - `eyJ` followed by 8+ token characters. This is a JWT/JWS header prefix; unlike the
 *   earlier pattern, no `.`-separated payload is required, so any such base64url JSON is redacted;
 * - URL userinfo: an `@` after `://` and before the next `/` or whitespace. Unlike the earlier
 *   pattern, a user without a password and any scheme spelling are redacted too;
 * - a `PRIVATE KEY-----` armour line, with or without its `-----BEGIN` label.
 */
function hasCredentialShape(text: string): boolean {
  let inAuthority = false;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index), prefixes = PREFIXES_BY_FIRST_CHAR.get(code);
    if (prefixes && (index === 0 || !isAlnum(text.charCodeAt(index - 1)))
      && prefixes.some(prefix => text.startsWith(prefix, index) && tokenCharsFollow(text, index + prefix.length, 10))) return true;
    if (code === 101 && text.startsWith(JWT_PREFIX, index) && tokenCharsFollow(text, index + JWT_PREFIX.length, 8)) return true;
    if (code === 80 && text.startsWith(PRIVATE_KEY_MARKER, index)) return true;
    if (code === 58 && text.startsWith("://", index)) { inAuthority = true; index += 2; }
    else if (code === 47 || isSpace(code)) inAuthority = false;
    else if (code === 64 && inAuthority) return true;
  }
  return false;
}

/**
 * Long mixed alphanumeric runs (`[A-Za-z0-9+=_-]{32,}`) look like keys. Pure hex/UUIDs (commit SHAs,
 * IDs) and words with a short numeric suffix remain because they are diagnostic, not credentials.
 */
function hasOpaqueBlob(text: string): boolean {
  // `notWord`: the run is not `[A-Za-z_-]+[0-9]{0,4}` (it has `+`/`=` or a digit before a non-digit).
  let length = 0, digit = false, letter = false, nonHex = false, notWord = false, trailingDigits = 0;
  for (let index = 0; index <= text.length; index++) {
    const code = index < text.length ? text.charCodeAt(index) : 32;
    if (isTokenChar(code) || code === 43 || code === 61) {
      length++;
      if (isDigit(code)) { digit = true; trailingDigits++; continue; }
      if (trailingDigits) notWord = true;
      trailingDigits = 0;
      if (isUpper(code) || isLower(code)) letter = true;
      if (code === 43 || code === 61) notWord = nonHex = true;
      else if (code !== 45 && !isHexLetter(code)) nonHex = true;
      continue;
    }
    if (length >= OPAQUE_RUN_CHARS && digit && letter && nonHex && (notWord || trailingDigits > 4)) return true;
    length = trailingDigits = 0; digit = letter = nonHex = notWord = false;
  }
  return false;
}

/** The reviewed credential predicate shared by every forwarded string, freeform or label. */
function credentialBearing(value: string): boolean {
  return mentionsSecretWord(value) || hasCredentialShape(value) || hasOpaqueBlob(value);
}

/**
 * Replaces each whitespace-delimited token that looks like it holds an email (a local-part character,
 * `@`, then a `.` later in the same token) wholesale. Package specifiers such as `name@1.2.3` are
 * therefore also replaced; `@Override` and `@scope/name` are not.
 */
function maskEmailTokens(text: string): string {
  let masked = "", copied = 0, start = 0, at = false, email = false, changed = false;
  for (let index = 0; index <= text.length; index++) {
    const code = index < text.length ? text.charCodeAt(index) : 32;
    if (!isSpace(code)) {
      if (code === 64 && index > start && isLocalChar(text.charCodeAt(index - 1))) at = true;
      else if (code === 46 && at) email = true;
      continue;
    }
    if (email) { masked += text.slice(copied, start) + REDACTED_EMAIL; copied = index; changed = true; }
    start = index + 1; at = email = false;
  }
  return changed ? masked + text.slice(copied) : text;
}

// ── Input boundary ───────────────────────────────────────────────────────────
// A freeform string longer than its bound is replaced wholesale by a marker
// before anything else reads it (only its length is used). It is never
// truncated, so no credential prefix survives. Everything within the bound is
// reviewed by the linear scans above.
export const omittedTextMarker = (length: number, maxChars: number) =>
  `[OMITTED: ${length} characters exceed the ${maxChars}-character bound]`;

export interface ReviewedText { text: string; redacted: boolean; omitted: boolean }

/** Bounds, then reviews, one freeform string: credential-bearing text is replaced entirely and email tokens are masked. */
export function redactDiagnosticText(value: string, maxChars = INCIDENT_DIAGNOSTIC_LIMITS.maxMessageChars): ReviewedText {
  if (value.length > maxChars) return { text: omittedTextMarker(value.length, maxChars), redacted: false, omitted: true };
  if (credentialBearing(value)) return { text: REDACTED_LINE, redacted: true, omitted: false };
  const masked = maskEmailTokens(value);
  return { text: masked, redacted: masked !== value, omitted: false };
}

// ── Log projection ───────────────────────────────────────────────────────────

/** Rejects deep nesting before JSON.parse; strings are skipped. */
function withinDepth(text: string, max: number): boolean {
  let depth = 0, inString = false, escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text.charCodeAt(index);
    if (inString) {
      if (escaped) escaped = false;
      else if (char === 92) escaped = true; // backslash
      else if (char === 34) inString = false; // quote
    } else if (char === 34) inString = true;
    else if (char === 123 || char === 91) { if (++depth > max) return false; }
    else if (char === 125 || char === 93) depth--;
  }
  return true;
}

// Artifact sources, entry sources, levels and artifact types/IDs are free
// strings upstream (not enums), so they get the same guard as messages. A
// label is forwarded only when it is a short identifier that the credential
// predicate accepts; otherwise it is dropped or normalized, never passed raw.
// Normal labels such as `phone`, `glasses`, logcat tags and package names remain.
export const UNKNOWN_LABEL = "unknown";
const LOG_LEVELS = new Set(["trace", "verbose", "debug", "info", "log", "notice", "warn", "warning", "error", "fatal", "critical"]);
const ARTIFACT_TYPES = new Set<string>(["logs", "screenshot", "state_snapshot"]);
const REPORT_KINDS = new Set<string>(["bug", "feedback", "automatic"]);
const REPORT_STATUSES = new Set<string>(["collecting", "ready", "closed"]);

// Labels are length-checked before any other inspection, like freeform text.
const MAX_SOURCE_CHARS = 64, MAX_LEVEL_CHARS = 16, MAX_ARTIFACT_ID_CHARS = 84, MAX_TIMESTAMP_CHARS = 32;

/** A reviewed diagnostic label, or null when it is malformed or credential-bearing. */
export function sourceLabel(value: unknown): string | null {
  return typeof value === "string" && value.length <= MAX_SOURCE_CHARS && /^[A-Za-z0-9._:-]{1,64}$/.test(value)
    && !credentialBearing(value) ? value : null;
}
/** Only the explicit level set is forwarded; anything else (including secret words) is `unknown`. */
export function logLevel(value: string): string {
  const level = value.length <= MAX_LEVEL_CHARS ? value.toLowerCase() : UNKNOWN_LABEL;
  return LOG_LEVELS.has(level) ? level : UNKNOWN_LABEL;
}
const artifactIdLabel = (value: unknown) =>
  typeof value === "string" && value.length <= MAX_ARTIFACT_ID_CHARS && artifactIdPattern.test(value) && !credentialBearing(value) ? value : null;
/** Stored report timestamps are ISO strings (`toISOString()`); anything else is not forwarded. */
const timestampLabel = (value: unknown) =>
  typeof value === "string" && value.length <= MAX_TIMESTAMP_CHARS && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    ? value : null;

export type LogProjection =
  | { state: "usable" | "empty"; bytes: Uint8Array; sha256: string; counts: Record<string, number> }
  | { state: "unreadable" | "oversized"; reason: string };

/** Deterministic: identical source bytes always produce identical emitted bytes. */
export function projectIncidentLog(raw: Uint8Array, identity: { reportId: string; artifactId: string; source: string; sourceSha256: string }): LogProjection {
  const limits = INCIDENT_DIAGNOSTIC_LIMITS;
  if (raw.byteLength > limits.maxSourceLogBytes) return { state: "oversized", reason: `Log bundle exceeds ${limits.maxSourceLogBytes} bytes.` };
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(raw); }
  catch { return { state: "unreadable", reason: "Log bundle is not valid UTF-8." }; }
  if (!withinDepth(text, limits.maxJsonDepth)) return { state: "unreadable", reason: "Log bundle exceeds the JSON depth bound." };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { state: "unreadable", reason: "Log bundle is not valid JSON." }; }
  const input = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { entries?: unknown }).entries : undefined;
  if (!Array.isArray(input)) return { state: "unreadable", reason: "Log bundle has no entries array." };

  // `input`, `invalid` and `omittedOldest` cover the whole bundle; the other counts describe emitted entries.
  const counts = { input: input.length, invalid: 0, emitted: 0, redacted: 0, omittedMessages: 0, omittedOldest: 0,
    unknownLevels: 0, rejectedSources: 0 };
  type Entry = { timestamp: number; level: string; message: string; source?: unknown };
  // Shape checks only; no string content is inspected here.
  const valid = input.filter((item): item is Entry => {
    const entry = item && typeof item === "object" ? item as Record<string, unknown> : null;
    const ok = !!entry && typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)
      && typeof entry.level === "string" && typeof entry.message === "string";
    if (!ok) counts.invalid++;
    return ok;
  });
  // Newest first: the tail nearest the failure is the most useful. Projection stops at the entry or
  // emitted-byte bound and the older entries are counted in `omittedOldest`. Each reviewed message
  // is at most maxMessageChars long and reviewed in linear time, so at most
  // maxEntries × maxMessageChars characters are scanned whatever the source contains.
  const kept: Array<{ timestamp: number; level: string; message: string; source?: string }> = [];
  let budget = limits.maxEmittedBytes - 1024;
  for (let index = valid.length - 1; index >= 0 && kept.length < limits.maxEntries; index--) {
    const entry = valid[index]!;
    const message = redactDiagnosticText(entry.message, limits.maxMessageChars), level = logLevel(entry.level), source = sourceLabel(entry.source);
    const projected = { timestamp: entry.timestamp, level, message: message.text, ...(source ? { source } : {}) };
    const size = Buffer.byteLength(JSON.stringify(projected)) + 1;
    if (size > budget) break;
    budget -= size;
    kept.push(projected);
    if (message.redacted) counts.redacted++;
    if (message.omitted) counts.omittedMessages++;
    if (level === UNKNOWN_LABEL) counts.unknownLevels++;
    if (entry.source !== undefined && !source) counts.rejectedSources++;
  }
  kept.reverse();
  counts.omittedOldest = valid.length - kept.length;
  counts.emitted = kept.length;
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, representation: LOG_REPRESENTATION,
    redactionPolicy: INCIDENT_DIAGNOSTIC_REDACTION_POLICY, reportId: identity.reportId,
    artifactId: artifactIdLabel(identity.artifactId) ?? UNKNOWN_LABEL, source: sourceLabel(identity.source) ?? UNKNOWN_LABEL,
    sourceSha256: identity.sourceSha256, counts, entries: kept }), "utf8");
  return { state: kept.length ? "usable" : "empty", bytes, sha256: createHash("sha256").update(bytes).digest("hex"), counts };
}

// ── Service ──────────────────────────────────────────────────────────────────

const missingKind = (source: string): MissingKind =>
  /glasses/i.test(source) ? "glasses-logs" : /phone|mobile|app/i.test(source) ? "phone-logs" : "other";
/** Freeform report text: bounded before anything else (including `trim`), then reviewed. */
function bounded(value: unknown, max = INCIDENT_DIAGNOSTIC_LIMITS.maxFieldChars): string | null {
  if (typeof value !== "string") return null;
  const reviewed = redactDiagnosticText(value, max);
  return reviewed.omitted || reviewed.text.trim() ? reviewed.text : null;
}

interface LogArtifactPlan {
  artifactId: string; source: string; sizeBytes: number | null;
  asset: StoredReport["assets"][number] | undefined; withinLimit: boolean;
}

export class TestFailureIncidentService {
  constructor(private readonly runs: Runs, private readonly store: IncidentReportStore = defaultStore) {}

  /** Exact membership in the stored occurrence, before any report query. */
  private async assigned(occurrenceId: string, reportId: string) {
    if (!reportIdPattern.test(reportId)) throw new TestRunError(400, "invalid reportId");
    const packet = await this.runs.failureDetail(occurrenceId);
    if (packet.occurrenceId !== occurrenceId || !packet.failure?.incidentIds?.includes(reportId))
      throw new TestRunError(404, "incident is not assigned to this occurrence");
  }

  private plan(stored: StoredReport) {
    const listed = stored.report.artifacts.slice(0, INCIDENT_DIAGNOSTIC_LIMITS.maxListedArtifacts);
    let logs = 0;
    return listed.map(artifact => {
      // Stored artifact fields are unconstrained strings; only reviewed labels are described or addressable.
      const artifactId = artifactIdLabel(artifact.artifactId);
      const source = sourceLabel(artifact.source) ?? UNKNOWN_LABEL;
      const type = ARTIFACT_TYPES.has(artifact.type) ? artifact.type : UNKNOWN_LABEL;
      const isLog = type === "logs" && artifactId !== null;
      const withinLimit = isLog && ++logs <= INCIDENT_DIAGNOSTIC_LIMITS.maxLogArtifacts;
      return { artifactId, type, source, plan: isLog ? { artifactId, source, sizeBytes: artifact.sizeBytes, withinLimit,
        asset: stored.assets.find(asset => asset.artifactId === artifactId) } satisfies LogArtifactPlan : null };
    });
  }

  private async project(reportId: string, plan: LogArtifactPlan): Promise<LogProjection | { state: Exclude<LogState, "usable" | "empty" | "unreadable" | "oversized">; reason: string }> {
    if (!plan.withinLimit) return { state: "over-limit", reason: `Only the first ${INCIDENT_DIAGNOSTIC_LIMITS.maxLogArtifacts} log artifacts are projected.` };
    if (!plan.asset) return { state: "asset-missing", reason: "Log artifact metadata exists but its stored payload row is missing." };
    if ((plan.asset.contentType || "").split(";")[0]!.trim().toLowerCase() !== "application/json")
      return { state: "unsupported", reason: "Only JSON log bundles are part of this diagnostic representation." };
    if (plan.asset.sizeBytes > INCIDENT_DIAGNOSTIC_LIMITS.maxSourceLogBytes)
      return { state: "oversized", reason: `Log bundle exceeds ${INCIDENT_DIAGNOSTIC_LIMITS.maxSourceLogBytes} bytes.` };
    let payload;
    try { payload = await this.store.readReportArtifactPayload(reportId, plan.artifactId); }
    catch { return { state: "unreadable", reason: "Stored log payload could not be read." }; }
    if (!payload) return { state: "asset-missing", reason: "Stored log payload row is missing." };
    const sourceSha256 = createHash("sha256").update(payload.bytes).digest("hex");
    if (payload.bytes.byteLength !== plan.asset.sizeBytes || sourceSha256 !== plan.asset.sha256)
      return { state: "unreadable", reason: "Stored log payload does not match its recorded size/SHA-256." };
    return projectIncidentLog(payload.bytes, { reportId, artifactId: plan.artifactId, source: plan.source, sourceSha256 });
  }

  async metadata(occurrenceId: string, reportId: string, basePath: string) {
    await this.assigned(occurrenceId, reportId);
    const common = { schemaVersion: 1 as const, occurrenceId, reportId, redactionPolicy: INCIDENT_DIAGNOSTIC_REDACTION_POLICY,
      note: "Incident diagnostics never change the failure outcome or its evidence completeness." };
    const stored = await this.store.getReport(reportId);
    if (!stored) return { ...common, availability: "missing" as const, report: null,
      logs: { state: "missing" as const, artifacts: [] }, omittedArtifacts: [],
      missingEvidence: [{ kind: "incident" as const, reason: "The incident is recorded on this failure but no report exists in this environment." }] };

    const { report } = stored;
    const missingEvidence: Array<{ kind: MissingKind; reason: string }> = [];
    const logArtifacts: Array<Record<string, unknown>> = [];
    const omittedArtifacts: Array<{ artifactId: string | null; type: string; source: string; reason: string }> = [];
    for (const { artifactId, type, source, plan } of this.plan(stored)) {
      if (!plan) {
        omittedArtifacts.push({ artifactId, type, source,
          reason: artifactId === null ? "Artifact identifier is not a reviewed diagnostic ID; the artifact is omitted."
            : type === "screenshot"
              ? "Incident screenshots are not part of this representation; run-assigned screenshots/recordings remain at the occurrence assets route."
              : type === "state_snapshot" ? "Raw state snapshots are omitted." : "Unknown artifact formats are omitted." });
        continue;
      }
      const result = await this.project(reportId, plan);
      const descriptor: Record<string, unknown> = { artifactId: plan.artifactId, source, state: result.state,
        sourceSizeBytes: plan.asset?.sizeBytes ?? plan.sizeBytes ?? null };
      if ("bytes" in result) Object.assign(descriptor, { counts: result.counts, representation: {
        contentType: REPRESENTATION_CONTENT_TYPE, sizeBytes: result.bytes.byteLength, sha256: result.sha256,
        path: `${basePath}/artifacts/${plan.artifactId}` } });
      else {
        descriptor.reason = result.reason;
        missingEvidence.push({ kind: missingKind(source), reason: `Log artifact ${plan.artifactId} is ${result.state}: ${result.reason}` });
      }
      if (result.state === "empty") missingEvidence.push({ kind: missingKind(source), reason: `Log artifact ${plan.artifactId} has no valid entries.` });
      logArtifacts.push(descriptor);
    }
    if (report.artifacts.length > INCIDENT_DIAGNOSTIC_LIMITS.maxListedArtifacts)
      missingEvidence.push({ kind: "other", reason: `Only the first ${INCIDENT_DIAGNOSTIC_LIMITS.maxListedArtifacts} incident artifacts are described.` });
    const states = logArtifacts.map(item => item.state);
    const state = states.includes("usable") ? "usable" as const
      : report.status === "collecting" ? "collecting" as const
        : states.some(item => ["unreadable", "oversized", "asset-missing", "over-limit", "empty"].includes(item as string)) ? "unreadable" as const
          : states.includes("unsupported") ? "unsupported" as const : "missing" as const;
    if (report.status === "collecting")
      missingEvidence.unshift({ kind: "incident", reason: "The incident is still collecting artifacts; its logs may be incomplete." });
    if (!logArtifacts.some(item => item.state === "usable" && missingKind(item.source as string) === "phone-logs"))
      missingEvidence.push({ kind: "phone-logs", reason: `No usable phone logs in this incident (logs: ${state}).` });

    return { ...common, availability: "found" as const,
      report: { kind: REPORT_KINDS.has(report.kind) ? report.kind : UNKNOWN_LABEL,
        status: REPORT_STATUSES.has(report.status) ? report.status : UNKNOWN_LABEL,
        createdAt: timestampLabel(report.createdAt), updatedAt: timestampLabel(report.updatedAt),
        trigger: report.trigger ? { type: report.trigger.type === "automatic" ? "automatic" as const : "manual" as const, source: bounded(report.trigger.source, 200),
          reason: bounded(report.trigger.reason, 500), sourceAppletPackageName: bounded(report.trigger.sourceAppletPackageName, 200) } : null,
        details: report.report ? { actualBehavior: bounded(report.report.actualBehavior), expectedBehavior: bounded(report.report.expectedBehavior),
          systemPriority: ["low", "medium", "high", "critical"].includes(report.report.systemPriority as string) ? report.report.systemPriority : null,
          userSeverity: [1, 2, 3, 4, 5].includes(report.report.userSeverity as number) ? report.report.userSeverity : null } : null },
      logs: { state, artifacts: logArtifacts }, omittedArtifacts, missingEvidence };
  }

  async artifact(occurrenceId: string, reportId: string, artifactId: string, request: Request): Promise<Response> {
    if (!artifactIdPattern.test(artifactId)) throw new TestRunError(400, "invalid artifactId");
    await this.assigned(occurrenceId, reportId);
    const stored = await this.store.getReport(reportId);
    if (!stored) throw new TestRunError(404, "incident report not found");
    // Only artifacts listed on this exact report are addressable.
    const plan = this.plan(stored).find(item => item.artifactId === artifactId)?.plan;
    if (!plan) throw new TestRunError(404, "artifact is not a diagnostic log of this incident");
    const result = await this.project(reportId, plan);
    if (!("bytes" in result)) throw new TestRunError(result.state === "oversized" ? 413 : result.state === "unreadable" ? 409 : 404,
      `log artifact is ${result.state}: ${result.reason}`);
    const headers = new Headers({ "Content-Type": REPRESENTATION_CONTENT_TYPE, "Content-Length": String(result.bytes.byteLength),
      "Content-Disposition": `attachment; filename="${artifactId}.diagnostic.json"`, "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox", "Cache-Control": "private, no-store",
      ETag: `"${result.sha256}"`, "Repr-Digest": `sha-256=:${Buffer.from(result.sha256, "hex").toString("base64")}:`,
      "X-Mentra-Representation-Sha256": result.sha256 });
    return new Response(request.method === "HEAD" ? null : result.bytes, { status: 200, headers });
  }
}
