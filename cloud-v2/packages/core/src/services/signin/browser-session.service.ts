/**
 * @fileoverview Core's portal sessions (the admin portal and the enterprise portal).
 *
 * A portal session is Core's own session after a sign-in through the
 * deployment's identity provider. The browser holds an opaque cookie value;
 * Core stores only its SHA-256. Sessions:
 *  - end after 7 days without use, and 30 days after sign-in at the latest;
 *  - rotate their cookie value after 24 hours, keeping the previous value
 *    valid for 60 seconds. Concurrent rotations converge on one value: one
 *    conditional `findOneAndUpdate` wins and the others re-read by the
 *    previous value;
 *  - belong to one portal: an admin session never reads as an enterprise
 *    portal session, nor the other way round;
 *  - end on their next request once their sign-in source is no longer
 *    configured, or once revoked (one session, all of a person's, or all of a
 *    source's).
 * `lastSeenAt` is written at most every 5 minutes.
 */

import {ulid} from "ulid"

import {BrowserSessionModel, type BrowserSession} from "../../models/browser-session.model"
import {isDeletedAccountId} from "../user.service"
import {isSourceEnabled} from "./config"
import {randomToken, sha256Hex} from "./random"

export type PortalKind = "admin" | "portal"

export interface SessionIdentity {
  mentraUserId: string
  tenantId: string
  sourceId: string
  subject: string
  email: string | null
  emailVerified: boolean
  authTime: Date
}

export const SESSION_IDLE_MS = 7 * 86_400_000
export const SESSION_ABSOLUTE_MS = 30 * 86_400_000
export const SESSION_ROTATE_AFTER_MS = 86_400_000
export const SESSION_PREVIOUS_GRACE_MS = 60_000
const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60_000
const MAX_COOKIE_LENGTH = 256

type SessionRow = BrowserSession & {_id: unknown}

export async function createPortalSession(
  portal: PortalKind,
  identity: SessionIdentity,
  now: Date = new Date(),
): Promise<{cookieValue: string}> {
  const cookieValue = randomToken()
  await BrowserSessionModel.create({
    sessionId: `bs_${ulid()}`,
    portal,
    tokenHash: sha256Hex(cookieValue),
    mentraUserId: identity.mentraUserId,
    tenantId: identity.tenantId,
    sourceId: identity.sourceId,
    subject: identity.subject,
    email: identity.email,
    emailVerified: identity.emailVerified,
    authTime: identity.authTime,
    createdAt: now,
    lastSeenAt: now,
    rotatedAt: now,
    absoluteExpiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_MS),
  })
  return {cookieValue}
}

function usable(row: SessionRow, portal: PortalKind, now: Date): boolean {
  if (row.portal !== portal || row.revokedAt) return false
  if (row.lastSeenAt.getTime() + SESSION_IDLE_MS <= now.getTime()) return false
  if (row.absoluteExpiresAt.getTime() <= now.getTime()) return false
  return isSourceEnabled(row.tenantId, row.sourceId)
}

function identityOf(row: SessionRow): SessionIdentity & {sessionId: string} {
  return {
    sessionId: row.sessionId,
    mentraUserId: row.mentraUserId,
    tenantId: row.tenantId,
    sourceId: row.sourceId,
    subject: row.subject,
    email: row.email ?? null,
    emailVerified: row.emailVerified,
    authTime: row.authTime,
  }
}

async function findByPreviousValue(hash: string, now: Date): Promise<SessionRow | null> {
  return BrowserSessionModel.findOne({previousTokenHash: hash, previousValidUntil: {$gt: now}}).lean<SessionRow>()
}

/**
 * The session a cookie value stands for, or null. A deleted account's session
 * is null. When the session is due for rotation, `rotatedCookieValue` is its
 * new value, which the caller must send back in a new cookie.
 */
export async function readPortalSession(
  portal: PortalKind,
  cookieValue: string,
  now: Date = new Date(),
): Promise<{session: SessionIdentity & {sessionId: string}; rotatedCookieValue: string | null} | null> {
  if (!cookieValue || cookieValue.length > MAX_COOKIE_LENGTH) return null
  const hash = sha256Hex(cookieValue)
  let row = await BrowserSessionModel.findOne({tokenHash: hash}).lean<SessionRow>()
  const viaPrevious = !row
  if (!row) row = await findByPreviousValue(hash, now)
  if (!row || !usable(row, portal, now)) return null
  // Deletion revokes the account's sessions; one that slipped past that is refused here.
  if (await isDeletedAccountId(row.mentraUserId)) return null

  let rotatedCookieValue: string | null = null
  if (!viaPrevious && now.getTime() - row.rotatedAt.getTime() >= SESSION_ROTATE_AFTER_MS) {
    const next = randomToken()
    const updated = await BrowserSessionModel.findOneAndUpdate(
      {_id: row._id, tokenHash: hash, revokedAt: null},
      {
        $set: {
          tokenHash: sha256Hex(next),
          previousTokenHash: hash,
          previousValidUntil: new Date(now.getTime() + SESSION_PREVIOUS_GRACE_MS),
          rotatedAt: now,
          lastSeenAt: now,
        },
      },
      {new: true},
    ).lean<SessionRow>()
    if (updated) {
      rotatedCookieValue = next
      row = updated
    } else {
      // Another request rotated it first (or it was revoked meanwhile): our
      // value is now the previous one, valid for the grace period.
      const winner = await findByPreviousValue(hash, now)
      if (!winner || !usable(winner, portal, now)) return null
      row = winner
    }
  } else if (now.getTime() - row.lastSeenAt.getTime() >= LAST_SEEN_WRITE_INTERVAL_MS) {
    await BrowserSessionModel.updateOne({_id: row._id, lastSeenAt: row.lastSeenAt}, {$set: {lastSeenAt: now}})
  }
  return {session: identityOf(row), rotatedCookieValue}
}

/** End the session a cookie value (current or previous) stands for. */
export async function revokePortalSession(cookieValue: string, reason: string): Promise<void> {
  if (!cookieValue || cookieValue.length > MAX_COOKIE_LENGTH) return
  const hash = sha256Hex(cookieValue)
  await BrowserSessionModel.updateOne(
    {$or: [{tokenHash: hash}, {previousTokenHash: hash}], revokedAt: null},
    {$set: {revokedAt: new Date(), revokedReason: reason}},
  )
}

/** End every portal session of one person. Returns how many were active. */
export async function revokePortalSessionsForUser(mentraUserId: string, reason: string): Promise<number> {
  const result = await BrowserSessionModel.updateMany(
    {mentraUserId, revokedAt: null},
    {$set: {revokedAt: new Date(), revokedReason: reason}},
  )
  return result.modifiedCount ?? 0
}

/** End every portal session that came from one sign-in source (tenant). */
export async function revokePortalSessionsForSource(tenantId: string, reason: string): Promise<number> {
  const result = await BrowserSessionModel.updateMany(
    {tenantId, revokedAt: null},
    {$set: {revokedAt: new Date(), revokedReason: reason}},
  )
  return result.modifiedCount ?? 0
}
