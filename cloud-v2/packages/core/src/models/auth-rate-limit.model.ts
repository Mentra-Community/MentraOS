/**
 * @fileoverview `auth_rate_limits`: fixed-window counters for Core's portal
 * sign-in routes, shared by every Core instance. One row per key and window;
 * rows expire (TTL) when their window ends.
 */

import {Schema, type InferSchemaType} from "mongoose"
import {registerModel} from "./register-model"

const AuthRateLimitSchema = new Schema(
  {
    /** `<key>:<window start in ms>`. */
    _id: {type: String, required: true},
    count: {type: Number, required: true},
    windowEndsAt: {type: Date, required: true},
  },
  {collection: "auth_rate_limits", versionKey: false},
)

AuthRateLimitSchema.index({windowEndsAt: 1}, {expireAfterSeconds: 0})

export type AuthRateLimit = InferSchemaType<typeof AuthRateLimitSchema>
export const AuthRateLimitModel = registerModel("AuthRateLimit", AuthRateLimitSchema)
