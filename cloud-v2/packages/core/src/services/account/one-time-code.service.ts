/**
 * @fileoverview Single-use one-time codes for account flows. Codes are stored
 * hashed with a purpose scope and TTL; issuing returns the plaintext once
 * (emailed or deep-linked), consuming verifies+burns atomically.
 */
import crypto from "node:crypto";
import { AccountCodeModel, type AccountCodePurpose } from "../../models/account-code.model";
import { AccountError } from "./account-error";

function hash(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

/** 6-digit numeric code for email flows (reset, email change, deletion). */
function numericCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

/** URL-safe opaque code for the oauth deep-link handoff. */
function opaqueCode(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export async function issueEmailCode(args: {
  purpose: Extract<AccountCodePurpose, "password_reset" | "email_change" | "account_deletion">;
  subject: string;
  ttlSec: number;
  payload?: unknown;
}): Promise<string> {
  // codeHash is globally unique but 6-digit codes are not: with enough live
  // codes two users WILL draw the same number (birthday bound), and the second
  // insert would 500 an innocent request. Redraw on duplicate-key instead.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = numericCode();
    try {
      await AccountCodeModel.create({
        codeHash: hash(code),
        purpose: args.purpose,
        subject: args.subject,
        payload: args.payload ?? null,
        expiresAt: new Date(Date.now() + args.ttlSec * 1000),
      });
      return code;
    } catch (err) {
      const dup = (err as { code?: number })?.code === 11000;
      if (!dup) throw err;
    }
  }
  throw new AccountError("server_error", "could not allocate a one-time code", 500);
}

export async function issueOAuthHandoff(args: {
  codeChallenge: string;
  ttlSec: number;
  payload: unknown;
}): Promise<string> {
  const code = opaqueCode();
  await AccountCodeModel.create({
    codeHash: hash(code),
    purpose: "oauth_handoff",
    subject: args.codeChallenge,
    payload: args.payload,
    expiresAt: new Date(Date.now() + args.ttlSec * 1000),
  });
  return code;
}

/**
 * The OAuth "start" record is keyed by the flow `state` (which comes back on
 * the provider callback), not by a code the app holds. Stored under a fixed
 * subject so it can't be confused with a handoff record.
 */
export async function issueOAuthStart(args: {
  state: string;
  ttlSec: number;
  payload: unknown;
}): Promise<void> {
  await AccountCodeModel.create({
    codeHash: hash(args.state),
    purpose: "oauth_handoff",
    subject: OAUTH_START_SUBJECT,
    payload: args.payload,
    expiresAt: new Date(Date.now() + args.ttlSec * 1000),
  });
}

export const OAUTH_START_SUBJECT = "__oauth_start__";

/**
 * Read an OAuth start record by `state` WITHOUT burning it. The callback needs
 * the stored verifier before it runs the (irreversible) GoTrue exchange; the
 * record is only consumed once the whole callback succeeds, so a transient
 * failure mid-callback leaves it intact rather than stranded-and-burned.
 */
export async function peekOAuthStart(state: string): Promise<{ payload: unknown } | null> {
  const doc = await AccountCodeModel.findOne({
    codeHash: hash(state),
    purpose: "oauth_handoff",
    subject: OAUTH_START_SUBJECT,
    consumedAt: null,
    expiresAt: { $gt: new Date() },
  }).lean();
  return doc ? { payload: doc.payload } : null;
}

/**
 * Verify + burn a code in one atomic update (findOneAndUpdate on consumedAt
 * null), so a concurrent double-submit can't consume the same code twice.
 * `expectSubject`, if given, must match (reset code bound to its email, etc.).
 * Returns the stored payload.
 */
export async function consumeCode(args: {
  code: string;
  purpose: AccountCodePurpose;
  expectSubject?: string;
}): Promise<{ subject: string; payload: unknown }> {
  const filter: Record<string, unknown> = {
    codeHash: hash(args.code),
    purpose: args.purpose,
    consumedAt: null,
    expiresAt: { $gt: new Date() },
  };
  if (args.expectSubject !== undefined) filter.subject = args.expectSubject;

  const doc = await AccountCodeModel.findOneAndUpdate(
    filter,
    { $set: { consumedAt: new Date() } },
  ).lean();
  if (!doc) throw new AccountError("code_invalid", "code is invalid, expired, or already used", 400);
  return { subject: doc.subject, payload: doc.payload };
}
