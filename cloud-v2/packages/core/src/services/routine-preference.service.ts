import {RoutinePreferenceModel} from "../models/routine-preference.model";
import {testWriteConcern} from "../models/test-write-concern";

export interface RoutinePreference {routineId: string; platform: string; nightlyEnabled: boolean}
export interface RoutinePreferenceRepository {
  list(): Promise<RoutinePreference[]>;
  get(routineId: string, platform: string): Promise<RoutinePreference | null>;
  set(preference: RoutinePreference): Promise<void>;
}
export const routinePreferences: RoutinePreferenceRepository = {
  async list() {return await RoutinePreferenceModel.find().select({_id: 0, routineId: 1, platform: 1, nightlyEnabled: 1})
    .read("primary").readConcern("majority").lean() as RoutinePreference[];},
  async get(routineId, platform) {return await RoutinePreferenceModel.findOne({routineId, platform})
    .select({_id: 0, routineId: 1, platform: 1, nightlyEnabled: 1}).read("primary").readConcern("majority").lean() as RoutinePreference | null;},
  async set(preference) {
    const {routineId, platform, nightlyEnabled} = preference;
    try {await RoutinePreferenceModel.updateOne({routineId, platform}, {$set: {nightlyEnabled}}, {upsert: true, writeConcern: testWriteConcern});}
    catch (error) {
      if ((error as {code?: number}).code !== 11000) throw error;
      // Concurrent first writes still address the one tuple, never create a second preference.
      await RoutinePreferenceModel.updateOne({routineId, platform}, {$set: {nightlyEnabled}}, {writeConcern: testWriteConcern});
    }
  },
};
