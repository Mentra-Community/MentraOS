import { Schema, type InferSchemaType } from "mongoose";
import { registerModel } from "./register-model";

/**
 * Org-scoped developer API key, owned entirely in our DB (no WorkOS). The full
 * secret is shown once at creation and never stored — we keep only a SHA-256
 * hash and the last 4 chars for display. The public `keyId` is embedded in the
 * token string so validation is an indexed lookup + a constant-time hash compare.
 *
 * Token shape: `msk_<env>_<keyId>.<secret>` (see developer-api-key.service.ts).
 */
const DeveloperOrgApiKeySchema = new Schema(
  {
    keyId: { type: String, required: true, unique: true },
    orgId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    env: { type: String, required: true },
    hash: { type: String, required: true },
    last4: { type: String, required: true },
    createdByUserId: { type: String, required: true },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "developer_org_api_keys" },
);

DeveloperOrgApiKeySchema.index({ orgId: 1, revokedAt: 1 });

export type DeveloperOrgApiKey = InferSchemaType<typeof DeveloperOrgApiKeySchema>;
export const DeveloperOrgApiKeyModel = registerModel("DeveloperOrgApiKey", DeveloperOrgApiKeySchema);
