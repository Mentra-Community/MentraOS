import {Schema} from "mongoose";
import {registerModel} from "./register-model";

/**
 * Read-only view of the old framework runs that old automated reports point at (see
 * report-native-detail.service.ts). It never writes, and it creates neither the collection nor an index.
 */
const schema = new Schema({
  runId: {type: String}, resultSchemaVersion: {type: Number}, payloadSha256: {type: String},
  uploadsComplete: {type: Boolean}, detail: {type: Schema.Types.Mixed},
}, {collection: "test_runs", autoIndex: false, autoCreate: false});

export const ReportNativeRunModel = registerModel("ReportNativeRun", schema);
