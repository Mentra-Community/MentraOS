/**
 * @fileoverview `login_transactions`: a sign-in in progress: a portal's, or
 * Core's sign-in server's at the customer's identity provider (`provider`,
 * with the provider interaction it completes).
 *
 * Created when the authorization code flow starts and consumed once,
 * atomically, by its callback. The browser holds an opaque cookie value; only
 * its SHA-256 is stored. Rows expire (TTL) ten minutes after they start.
 */

import {Schema, type InferSchemaType} from "mongoose"
import {PORTAL_KINDS} from "./browser-session.model"
import {registerModel} from "./register-model"

const LoginTransactionSchema = new Schema(
  {
    txHash: {type: String, required: true, unique: true},
    portal: {type: String, enum: [...PORTAL_KINDS, "provider"], required: true},
    /** `provider` transactions: the sign-in server's interaction this sign-in completes. */
    interactionUid: {type: String, default: null},
    state: {type: String, required: true},
    nonce: {type: String, required: true},
    pkceVerifier: {type: String, required: true},
    returnTo: {type: String, required: true},
    expiresAt: {type: Date, required: true},
  },
  {timestamps: {createdAt: true, updatedAt: false}, collection: "login_transactions"},
)

LoginTransactionSchema.index({expiresAt: 1}, {expireAfterSeconds: 0})

export type LoginTransactionRow = InferSchemaType<typeof LoginTransactionSchema>
export const LoginTransactionModel = registerModel("LoginTransaction", LoginTransactionSchema)
