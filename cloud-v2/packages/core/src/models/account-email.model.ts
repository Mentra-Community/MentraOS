/**
 * @fileoverview `account_emails`: Core's copy of each account's verified email.
 *
 * The account directory (GoTrue, on hosted Core) owns a Mentra account's email.
 * Asking it every time a request wants the email would put every active phone
 * on it, so Core keeps a copy here: one row per account, with the verified
 * email (null when the account has none, its email is unverified, or it is not
 * a Mentra account), when Core learned it (`checkedAt`), and whether Core has
 * changed the email since (`recheck`).
 * `services/account/account-email.service.ts` reads and writes it.
 *
 * Deleting the account clears the row's email and sets `deletedAt`, once and
 * for good. Every write's filter requires `deletedAt: null`, so a lookup or an
 * email change still in flight when the account is deleted cannot write the
 * email back: the row is the fence, and it holds no email.
 */

import {Schema, type InferSchemaType} from "mongoose"
import {registerModel} from "./register-model"

const AccountEmailSchema = new Schema(
  {
    mentraUserId: {type: String, required: true, unique: true},
    email: {type: String, default: null},
    /** When the lookup that gave this answer started, or, once Core changed the email, when it did. */
    checkedAt: {type: Date, required: true},
    /** Core changed the email in the directory after this answer: the next lookup asks the directory again. */
    recheck: {type: Boolean, default: false},
    /** When the account was deleted. The row then holds no email, and nothing writes one again. */
    deletedAt: {type: Date, default: null},
  },
  {collection: "account_emails", versionKey: false},
)

export type AccountEmail = InferSchemaType<typeof AccountEmailSchema>
export const AccountEmailModel = registerModel("AccountEmail", AccountEmailSchema)
