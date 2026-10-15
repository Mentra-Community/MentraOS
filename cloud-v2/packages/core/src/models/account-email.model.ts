/**
 * @fileoverview `account_emails`: Core's copy of each account's verified email.
 *
 * The account directory (GoTrue, on hosted Core) owns a Mentra account's email.
 * Asking it every time a request wants the email would put every active phone
 * on it, so Core keeps a copy here: one row per account, with the verified
 * email (null when the account has none, its email is unverified, or it is not
 * a Mentra account) and when Core learned it (`checkedAt`).
 * `services/account/account-email.service.ts` reads and writes it. The row is
 * deleted with the account.
 */

import {Schema, type InferSchemaType} from "mongoose"
import {registerModel} from "./register-model"

const AccountEmailSchema = new Schema(
  {
    mentraUserId: {type: String, required: true, unique: true},
    email: {type: String, default: null},
    /** When the directory gave this answer (the time the lookup started), or when Core changed the email itself. */
    checkedAt: {type: Date, required: true},
  },
  {collection: "account_emails", versionKey: false},
)

export type AccountEmail = InferSchemaType<typeof AccountEmailSchema>
export const AccountEmailModel = registerModel("AccountEmail", AccountEmailSchema)
