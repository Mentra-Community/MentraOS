import {z} from 'zod';
import {testWriteConcern} from "../models/test-write-concern";
import {RoutineDefinitionModel} from "../models/routine-definition.model";
import {RoutineCollectionModel} from '../models/routine-collection.model';
import {testingTarget} from '../types/testing-source.types';
import {RoutineWorkModel} from '../models/routine-work.model';
import {authoringJobViewSchema} from '../types/routine-work.types';
import {routineEnrollmentSchema, routineCardDefinitionSchema, routineCatalogDefinitionSchema, type RoutineCatalogDefinition, type RoutineEnrollment, type RecordedRoutineEnrollment, type RoutineCardDefinition} from "../types/routine-definition.types";
import {requestInputDigest} from "./test-request.service";
import {CandidateVerificationService, type CandidateAuthorization} from './candidate-verification.service';
import {GithubRoutineMergeGateway, RoutineMergeEligibilityService} from './routine-merge-eligibility.service';

import {readRoutineDefinition, writeRoutineDefinition, routineCollectionDetailSchema, readRoutineCollection} from './routine-definition-detail.service';

export class RoutineDefinitionConflict extends Error {}
const catalogCollectionSchema = routineCollectionDetailSchema.extend({version: z.number().int().positive().safe(),
  definitions: z.array(routineCatalogDefinitionSchema).min(1).max(1000)});
function catalogProjection(row: {commit: string; version: number; manifestSha256: string; catalog?: unknown}) {
  const collection = catalogCollectionSchema.parse(row.catalog);
  if (collection.commit !== row.commit || collection.version !== row.version || requestInputDigest(collection) !== row.manifestSha256)
    throw new RoutineDefinitionConflict('Published catalog projection differs');
  return collection;
}
function cardDefinition(row: RoutineCatalogDefinition): RoutineCardDefinition {
  return routineCardDefinitionSchema.parse({routineId: row.routineId, platform: row.platform,
    definitionRevision: row.definitionRevision, definitionSha256: row.definitionSha256,
    definition: {title: row.definition.title, purpose: row.definition.purpose,
      ...(row.definition.glasses ? {glasses: {models: row.definition.glasses.models}} : {})}});
}
export interface RoutineDefinitionRepository {
  enroll(row: RoutineEnrollment): Promise<void>;
  current(): Promise<RoutineCatalogDefinition[]>;
  overview(): Promise<RoutineCardDefinition[]>;
  getCurrent(routineId: string, platform: string): Promise<RoutineCatalogDefinition | null>;
  getExact(routineId: string, platform: string, revision: string, ordinaryOnly?: boolean): Promise<RoutineEnrollment | null>;
}
const mongoRepository: RoutineDefinitionRepository = {
  async enroll(row) {
    const identity = {routineId: row.routineId, platform: row.platform, definitionRevision: row.definitionRevision};
    const {verification} = row;
    const definition = await writeRoutineDefinition(row);
    try {
      await RoutineDefinitionModel.create([{...definition, ...(verification ? {candidateBindings: [verification]} :
        {ordinaryEnrolledAt: new Date()})}], {writeConcern: testWriteConcern});
    } catch (error) {
      if ((error as {code?: number}).code !== 11000) throw error;
      const existing = await RoutineDefinitionModel.findOne(identity).read('primary').readConcern('majority').lean();
      if (!existing || !existing.routineSource || existing.definitionSha256 !== row.definitionSha256 ||
          requestInputDigest(existing.routineSource) !== requestInputDigest(row.routineSource) ||
          (await readRoutineDefinition(existing)).definitionSha256 !== row.definitionSha256)
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
    const latest = await RoutineCollectionModel.findOne().sort({version: -1})
      .read('primary').readConcern('majority').lean();
    if (!latest) return [];
    const collection = latest.catalog ? catalogProjection(latest) : await readRoutineCollection(latest.detail);
    if (collection.commit !== latest.commit || collection.version !== latest.version || requestInputDigest(collection) !== latest.manifestSha256)
      throw new RoutineDefinitionConflict('Published collection manifest differs');
    const rows = collection.definitions;
    if (rows.length !== latest.members.length || rows.some((row, index) => row.routineId !== latest.members[index]?.routineId ||
      row.platform !== latest.members[index]?.platform || row.definitionSha256 !== latest.members[index]?.definitionSha256))
      throw new RoutineDefinitionConflict('Published collection members differ');
    return rows.map(row => latest.catalog ? routineCatalogDefinitionSchema.parse(row) : routineEnrollmentSchema.parse(row));
  },
  async getCurrent(routineId, platform) {
    return (await this.current()).find(row => row.routineId === routineId && row.platform === platform) ?? null;
  },
  async overview() {
    const latest = await RoutineCollectionModel.findOne().sort({version: -1})
      .select({commit: 1, version: 1, manifestSha256: 1, catalog: 1, members: 1}).read('primary').readConcern('majority').lean();
    if (!latest) return [];
    if (latest.catalog) return catalogProjection(latest).definitions.map(cardDefinition);
    const stored = await RoutineDefinitionModel.find({definitionRevision: latest.commit,
      $or: latest.members.map(member => ({routineId: member.routineId, platform: member.platform}))})
      .select({routineId: 1, platform: 1, definitionRevision: 1, definitionSha256: 1,
        card: 1, _id: 0})
      .read('primary').readConcern('majority').lean();
    // Displayed rows belong to the chosen publication. Only current() reads and
    // verifies every definition byte against the complete manifest digest.
    return latest.members.map(member => {
      const row = stored.find(value => value.routineId === member.routineId && value.platform === member.platform);
      if (!row || row.definitionSha256 !== member.definitionSha256)
        throw new RoutineDefinitionConflict('Published collection member is unavailable');
      const {card, ...identity} = row;
      return routineCardDefinitionSchema.parse({...identity, definition: card});
    });
  },
  async getExact(routineId, platform, definitionRevision, ordinaryOnly = false) {
    const row = await RoutineDefinitionModel.findOne({routineId, platform, definitionRevision,
      ...(ordinaryOnly ? {ordinaryEnrolledAt: {$exists: true}} : {})})
      .read('primary').readConcern('majority').lean();
    if (!row) return null;
    return routineEnrollmentSchema.parse(await readRoutineDefinition(row));
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
  /** One source-only catalog update; it never enrolls executable source or promotes requests. */
  async publishCollection(input: unknown) {
    const parsed = catalogCollectionSchema.safeParse(input);
    if (!parsed.success) throw new RoutineDefinitionConflict('Invalid published catalog');
    const collection = parsed.data;
    const identities = collection.definitions.map(row => `${row.routineId}:${row.platform}`);
    if (new Set(identities).size !== identities.length || collection.definitions.some(row =>
      row.definitionRevision !== collection.commit || row.definition.source.repository !== (collection.repository ?? testingTarget().repository) ||
      requestInputDigest(row.definition) !== row.definitionSha256))
      throw new RoutineDefinitionConflict('Published catalog identity or exact definition differs');
    collection.definitions.sort((left, right) => `${left.routineId}:${left.platform}`.localeCompare(`${right.routineId}:${right.platform}`));
    const manifestSha256 = requestInputDigest(collection);
    const committed = () => RoutineCollectionModel.findOne({$or: [{commit: collection.commit}, {version: collection.version}]})
      .read('primary').readConcern('majority').lean();
    const matches = (row: Awaited<ReturnType<typeof committed>>) => row && row.commit === collection.commit &&
      row.version === collection.version && row.manifestSha256 === manifestSha256;
    const existing = await committed();
    if (existing && !matches(existing)) throw new RoutineDefinitionConflict('Published immutable catalog conflicts');
    if (!existing) {
      try {
        await RoutineCollectionModel.create([{commit: collection.commit, version: collection.version, manifestSha256,
          catalog: collection, members: collection.definitions.map(row => ({routineId: row.routineId, platform: row.platform,
            definitionSha256: row.definitionSha256}))}], {writeConcern: testWriteConcern});
      } catch (error) {
        if ((error as {code?: number}).code !== 11000) throw error;
        if (!matches(await committed())) throw new RoutineDefinitionConflict('Concurrent immutable catalog conflicts');
      }
    }
    return {commit: collection.commit, version: collection.version, definitions: collection.definitions.length};
  }
  current() {return this.repository.current();}
  overview() {return this.repository.overview();}
  getCurrent(routineId: string, platform: string) {return this.repository.getCurrent(routineId, platform);}
  getExact(routineId: string, platform: string, revision: string, ordinaryOnly = false) {
    return this.repository.getExact(routineId, platform, revision, ordinaryOnly);
  }
  /** Display original steps without claiming an old definition implements the installed executable API. */
  async getRecordedExact(routineId: string, platform: string, definitionRevision: string): Promise<RecordedRoutineEnrollment | null> {
    const row = await RoutineDefinitionModel.findOne({routineId, platform, definitionRevision}).read('primary').readConcern('majority').lean();
    return row ? readRoutineDefinition(row) : null;
  }
}
