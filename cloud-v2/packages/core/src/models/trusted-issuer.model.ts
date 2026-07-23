import { Schema, type InferSchemaType } from "mongoose";
import { registerModel } from "./register-model";

const TrustedIssuerSchema = new Schema(
  {
    trustedIssuerId: { type: String, required: true, unique: true },
    enterpriseOrgId: { type: String, required: true, index: true },
    environmentName: { type: String, required: true },
    // `issuer` is the exact HTTPS `iss` value we pin at signature-verification
    // time — it is NOT the token-exchange lookup key (that is the minted
    // (tenantId, env) claims). So it is intentionally NOT globally unique: the same
    // IdP issuer URL may legitimately serve multiple environments, and multiple
    // enterprise orgs. Uniqueness is scoped to (enterpriseOrgId, environmentName)
    // by the compound index below.
    issuer: { type: String, required: true },
    jwksUrl: { type: String, required: true },
    subjectClaim: { type: String, default: "sub" },
    enabled: { type: Boolean, default: true, index: true },
    createdBy: { type: String, required: true },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true, collection: "trusted_issuers" },
);

TrustedIssuerSchema.index({ enterpriseOrgId: 1, environmentName: 1 }, { unique: true });

export type TrustedIssuer = InferSchemaType<typeof TrustedIssuerSchema>;
export const TrustedIssuerModel = registerModel("TrustedIssuer", TrustedIssuerSchema);
