import {Schema} from "mongoose";
import {registerModel} from "./register-model";

/** Scheduling preferences belong to a routine/platform, not a definition revision. */
const schema = new Schema({
  routineId: {type: String, required: true},
  platform: {type: String, required: true},
  nightlyEnabled: {type: Boolean, required: true},
}, {collection: "routine_preferences", timestamps: true});
schema.index({routineId: 1, platform: 1}, {unique: true});
export const RoutinePreferenceModel = registerModel("RoutinePreference", schema);
