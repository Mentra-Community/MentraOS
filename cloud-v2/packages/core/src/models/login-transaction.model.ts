/**
 * @fileoverview `login_transactions`: a portal sign-in in progress.
 *
 * Created when a portal starts the authorization code flow and consumed once,
 * atomically, by its callback. The browser holds an opaque cookie value; only
 * its SHA-256 is stored. Rows expire (TTL) ten minutes after they start.
 */

import {Schema, type InferSchemaType} from "mongoose"
import {PORTAL_KINDS} from "./browser-session.model"
import {registerModel} from "./register-model"

const LoginTransactionSchema = new Schema(
  {
    txHash: {type: String, required: true, unique: true},
    portal: {type: String, enum: PORTAL_KINDS, required: true},
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
