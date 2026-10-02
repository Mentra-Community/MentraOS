import {RoutineDefinitionModel} from "../models/routine-definition.model";
import {routineEnrollmentSchema, type RoutineEnrollment} from "../types/routine-definition.types";
import {requestInputDigest} from "./test-request.service";

export class RoutineDefinitionConflict extends Error {}
export interface RoutineDefinitionRepository {
  enroll(row: RoutineEnrollment): Promise<void>;
  current(): Promise<RoutineEnrollment[]>;
  getCurrent(routineId: string, platform: string): Promise<RoutineEnrollment | null>;
}
const mongoRepository: RoutineDefinitionRepository = {
  async enroll(row) {
    // The current pointer and immutable revision are committed together.
    await RoutineDefinitionModel.db.transaction(async session => {
      const identity = {routineId: row.routineId, platform: row.platform, definitionRevision: row.definitionRevision};
      const existing = await RoutineDefinitionModel.findOne(identity).session(session).lean();
      if (existing && existing.definitionSha256 !== row.definitionSha256)
        throw new RoutineDefinitionConflict("Definition revision already has different contents");
      if (!existing) await RoutineDefinitionModel.create([{...row, isCurrent: false}], {session});
      await RoutineDefinitionModel.updateMany({routineId: row.routineId, platform: row.platform, isCurrent: true},
        {$set: {isCurrent: false}}, {session});
      await RoutineDefinitionModel.updateOne(identity, {$set: {isCurrent: true}}, {session});
    });
  },
  async current() {
    return await RoutineDefinitionModel.find({isCurrent: true}).sort({routineId: 1, platform: 1})
      .select({routineId: 1, platform: 1, definitionRevision: 1, definitionSha256: 1, definition: 1, _id: 0})
      .lean() as RoutineEnrollment[];
  },
  async getCurrent(routineId, platform) {
    return await RoutineDefinitionModel.findOne({routineId, platform, isCurrent: true})
      .select({routineId: 1, platform: 1, definitionRevision: 1, definitionSha256: 1, definition: 1, _id: 0})
      .lean() as RoutineEnrollment | null;
  },
};
export class RoutineDefinitionService {
  constructor(private readonly repository: RoutineDefinitionRepository = mongoRepository) {}
  async enroll(input: unknown) {
    const parsed = routineEnrollmentSchema.safeParse(input);
    if (!parsed.success) throw new RoutineDefinitionConflict("Invalid routine definition enrollment");
    const row = parsed.data;
    if (requestInputDigest(row.definition) !== row.definitionSha256)
      throw new RoutineDefinitionConflict("Definition digest does not match its contents");
    await this.repository.enroll(row);
    return row;
  }
  current() {return this.repository.current();}
  getCurrent(routineId: string, platform: string) {return this.repository.getCurrent(routineId, platform);}
}
