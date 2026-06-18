import { Schema, model, type InferSchemaType } from "mongoose";

const TrustedIssuerSchema = new Schema(
  {
    trustedIssuerId: { type: String, required: true, unique: true },
    enterpriseOrgId: { type: String, required: true, index: true },
    environmentName: { type: String, required: true },
    issuer: { type: String, required: true, unique: true },
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
export const TrustedIssuerModel = model("TrustedIssuer", TrustedIssuerSchema);
