import {testWriteConcern} from "../models/test-write-concern";
import {RoutineDefinitionModel} from "../models/routine-definition.model";
import {RoutineWorkModel} from '../models/routine-work.model';
import {authoringJobViewSchema} from '../types/routine-work.types';
import {routineEnrollmentSchema, type RoutineEnrollment} from "../types/routine-definition.types";
import {requestInputDigest} from "./test-request.service";
import {CandidateVerificationService, type CandidateAuthorization} from './candidate-verification.service';
import {GithubRoutineMergeGateway, RoutineMergeEligibilityService} from './routine-merge-eligibility.service';

export class RoutineDefinitionConflict extends Error {}
export interface RoutineDefinitionRepository {
  enroll(row: RoutineEnrollment): Promise<void>;
  current(): Promise<RoutineEnrollment[]>;
  getCurrent(routineId: string, platform: string): Promise<RoutineEnrollment | null>;
}
const mongoRepository: RoutineDefinitionRepository = {
  async enroll(row) {
    const identity = {routineId: row.routineId, platform: row.platform, definitionRevision: row.definitionRevision};
    const {verification, ...definition} = row;
    try {
      await RoutineDefinitionModel.create([{...definition, ...(verification ? {candidateBindings: [verification]} :
        {ordinaryEnrolledAt: new Date()})}], {writeConcern: testWriteConcern});
    } catch (error) {
      if ((error as {code?: number}).code !== 11000) throw error;
      const existing = await RoutineDefinitionModel.findOne(identity).read('primary').readConcern('majority').lean();
      if (!existing || existing.definitionSha256 !== row.definitionSha256 ||
          requestInputDigest(existing.definition) !== row.definitionSha256)
        throw new RoutineDefinitionConflict("Definition revision already has different contents");
      if (verification) {
        // One current binding per work ID; retries cannot grow the metadata or rewrite source.
        const bindings = (existing.candidateBindings ?? []) as NonNullable<RoutineEnrollment['verification']>[];
        const original = bindings.find(value => value.workId === verification.workId);
        if (original && requestInputDigest(original) !== requestInputDigest(verification)) {
          if (original.attemptId >= verification.attemptId)
            throw new RoutineDefinitionConflict('Candidate definition is already bound to another attempt');
          await RoutineDefinitionModel.updateOne({...identity, candidateBindings: {$elemMatch: original}},
            {$set: {'candidateBindings.$': verification}}, {writeConcern: testWriteConcern});
        }
        if (!original) {
          await RoutineDefinitionModel.updateOne({...identity, 'candidateBindings.workId': {$ne: verification.workId},
            $expr: {$lt: [{$size: {$ifNull: ['$candidateBindings', []]}}, 20]}},
            {$addToSet: {candidateBindings: verification}}, {writeConcern: testWriteConcern});
        }
        if (!original || requestInputDigest(original) !== requestInputDigest(verification)) {
          const settled = await RoutineDefinitionModel.findOne(identity).read('primary').readConcern('majority').lean();
          if (!(settled?.candidateBindings as typeof bindings | undefined)?.some(value =>
            requestInputDigest(value) === requestInputDigest(verification)))
            throw new RoutineDefinitionConflict('Candidate definition authorization changed or reached its limit');
        }
      } else if (!existing.ordinaryEnrolledAt) {
        if (existing.candidateBindings?.length) {
          let merged = false;
          for (const binding of existing.candidateBindings) {
            const job = await RoutineWorkModel.findOne({workId: binding.workId}).read('primary').readConcern('majority').lean();
            const view = authoringJobViewSchema.safeParse(job?.status?.details);
            const review = view.success ? view.data.details.review : undefined;
            if (review?.sourceRevision === row.definitionRevision && review.verdict === 'APPROVED' &&
                await new GithubRoutineMergeGateway().merged(review.prUrl, review.sourceRevision, row.definitionRevision)) {
              merged = true; break;
            }
          }
          if (!merged) throw new RoutineDefinitionConflict('Candidate revision requires confirmed normal merged-source enrollment');
        }
        await RoutineDefinitionModel.updateOne({...identity, ordinaryEnrolledAt: {$exists: false}},
          {$set: {ordinaryEnrolledAt: new Date()}}, {writeConcern: testWriteConcern});
      }
    }
  },
  async current() {
    // A candidate insertion cannot replace the latest ordinary enrollment.
    return await RoutineDefinitionModel.aggregate<RoutineEnrollment>([
      {$match: {ordinaryEnrolledAt: {$type: 'date'}}},
      {$sort: {ordinaryEnrolledAt: -1, _id: -1}},
      {$group: {_id: {routineId: "$routineId", platform: "$platform"}, row: {$first: "$$ROOT"}}},
      {$replaceRoot: {newRoot: "$row"}},
      {$sort: {routineId: 1, platform: 1}},
      {$project: {_id: 0, routineId: 1, platform: 1, definitionRevision: 1, definitionSha256: 1, definition: 1}},
    ]);
  },
  async getCurrent(routineId, platform) {
    return await RoutineDefinitionModel.findOne({routineId, platform, ordinaryEnrolledAt: {$type: 'date'}}).sort({ordinaryEnrolledAt: -1, _id: -1})
      .select({routineId: 1, platform: 1, definitionRevision: 1, definitionSha256: 1, definition: 1, _id: 0})
      .lean() as RoutineEnrollment | null;
  },
};
export class RoutineDefinitionService {
  constructor(private readonly repository: RoutineDefinitionRepository = mongoRepository,
    private readonly candidates: CandidateAuthorization = new CandidateVerificationService(),
    private readonly promotion: Pick<RoutineMergeEligibilityService, 'enroll'> | null =
      repository === mongoRepository ? new RoutineMergeEligibilityService() : null) {}
  async enroll(input: unknown, authenticatedHostId?: string) {
    const parsed = routineEnrollmentSchema.safeParse(input);
    if (!parsed.success) throw new RoutineDefinitionConflict("Invalid routine definition enrollment");
    const row = parsed.data;
    if (requestInputDigest(row.definition) !== row.definitionSha256)
      throw new RoutineDefinitionConflict("Definition digest does not match its contents");
    if (row.verification) {
      if (!authenticatedHostId) throw new RoutineDefinitionConflict('Candidate enrollment requires the authenticated host');
      await this.candidates.authorize(row.verification, authenticatedHostId, row);
    }
    await this.repository.enroll(row);
    if (!row.verification) await this.promotion?.enroll(row);
    return row;
  }
  current() {return this.repository.current();}
  getCurrent(routineId: string, platform: string) {return this.repository.getCurrent(routineId, platform);}
}
