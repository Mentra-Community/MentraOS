/**
 * @fileoverview `browser_sessions`: Core's own sessions for its portal websites.
 *
 * One row per signed-in portal session (the admin portal or the enterprise
 * portal). The browser holds an opaque 256-bit cookie value; only its SHA-256
 * is stored (`tokenHash`). A session rotates its value after 24 hours, and the
 * previous value stays valid for 60 seconds (`previousTokenHash` until
 * `previousValidUntil`) so concurrent requests carrying it are not signed out.
 *
 * A session keeps no identity-provider tokens: it records who signed in, from
 * which sign-in source, with which email and whether that email was verified,
 * at sign-in time. A changed email takes effect at the next sign-in.
 *
 * Rows expire (TTL) at their absolute lifetime.
 */

import {Schema, type InferSchemaType} from "mongoose"
import {registerModel} from "./register-model"

export const PORTAL_KINDS = ["admin", "portal"] as const

const BrowserSessionSchema = new Schema(
  {
    sessionId: {type: String, required: true, unique: true},
    portal: {type: String, enum: PORTAL_KINDS, required: true},
    tokenHash: {type: String, required: true, unique: true},
    previousTokenHash: {type: String, default: null},
    previousValidUntil: {type: Date, default: null},

    mentraUserId: {type: String, required: true, index: true},
    /** Sign-in source: the tenant half of the Core user key, and the source (provider) id. */
    tenantId: {type: String, required: true, index: true},
    sourceId: {type: String, required: true},
    subject: {type: String, required: true},
    email: {type: String, default: null},
    emailVerified: {type: Boolean, required: true},
    authTime: {type: Date, required: true},

    createdAt: {type: Date, required: true},
    lastSeenAt: {type: Date, required: true},
    rotatedAt: {type: Date, required: true},
    absoluteExpiresAt: {type: Date, required: true},
    revokedAt: {type: Date, default: null},
    revokedReason: {type: String, default: null},
  },
  {collection: "browser_sessions"},
)

// The previous value is looked up only within its grace window; sparse keeps nulls out.
BrowserSessionSchema.index({previousTokenHash: 1}, {sparse: true})
BrowserSessionSchema.index({absoluteExpiresAt: 1}, {expireAfterSeconds: 0})

export type BrowserSession = InferSchemaType<typeof BrowserSessionSchema>
export const BrowserSessionModel = registerModel("BrowserSession", BrowserSessionSchema)
