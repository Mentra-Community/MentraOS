import {Schema} from "mongoose";
import {registerModel} from "./register-model";

/** Definitions are enrolled from source; passing examples come from test_runs. */
const schema = new Schema({
  routineId: {type: String, required: true, immutable: true},
  platform: {type: String, required: true, enum: ["ios-on-mac", "android"], immutable: true},
  definitionRevision: {type: String, required: true, immutable: true},
  definitionSha256: {type: String, required: true, immutable: true},
  routineSource: {type: Schema.Types.Mixed, required: true, immutable: true},
  definition: {type: Schema.Types.Mixed, required: true, immutable: true},
  ordinaryEnrolledAt: {type: Date},
  candidateBindings: {type: [Schema.Types.Mixed], default: undefined},
}, {collection: "routine_definitions", timestamps: true});
schema.index({routineId: 1, platform: 1, definitionRevision: 1}, {unique: true});
schema.index({routineId: 1, platform: 1, createdAt: -1, _id: -1});
schema.index({routineId: 1, platform: 1, ordinaryEnrolledAt: -1, _id: -1});
export const RoutineDefinitionModel = registerModel("RoutineDefinition", schema);
