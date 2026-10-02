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
    const identity = {routineId: row.routineId, platform: row.platform, definitionRevision: row.definitionRevision};
    try {
      // An immutable revision is one atomic insert. Retrying it does not promote an old revision.
      await RoutineDefinitionModel.create(row);
    } catch (error) {
      if ((error as {code?: number}).code !== 11000) throw error;
      const existing = await RoutineDefinitionModel.findOne(identity).lean();
      if (!existing || existing.definitionSha256 !== row.definitionSha256)
        throw new RoutineDefinitionConflict("Definition revision already has different contents");
    }
  },
  async current() {
    // Current means latest newly enrolled revision. No multi-document pointer or transaction.
    return await RoutineDefinitionModel.aggregate<RoutineEnrollment>([
      {$sort: {createdAt: -1, _id: -1}},
      {$group: {_id: {routineId: "$routineId", platform: "$platform"}, row: {$first: "$$ROOT"}}},
      {$replaceRoot: {newRoot: "$row"}},
      {$sort: {routineId: 1, platform: 1}},
      {$project: {_id: 0, routineId: 1, platform: 1, definitionRevision: 1, definitionSha256: 1, definition: 1}},
    ]);
  },
  async getCurrent(routineId, platform) {
    return await RoutineDefinitionModel.findOne({routineId, platform}).sort({createdAt: -1, _id: -1})
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
