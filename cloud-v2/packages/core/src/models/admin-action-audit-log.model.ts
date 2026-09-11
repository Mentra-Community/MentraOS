import { Schema, type InferSchemaType } from "mongoose";
import { registerModel } from "./register-model";

const AdminActionAuditLogSchema = new Schema(
  {
    adminId: { type: String, required: true, index: true },
    action: { type: String, required: true, index: true },
    targetType: { type: String, required: true, index: true },
    targetId: { type: String, required: true, index: true },
    reason: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: "admin_action_audit_logs" },
);

AdminActionAuditLogSchema.index({ createdAt: -1 });

export type AdminActionAuditLog = InferSchemaType<typeof AdminActionAuditLogSchema>;
export const AdminActionAuditLogModel = registerModel("AdminActionAuditLog", AdminActionAuditLogSchema);
