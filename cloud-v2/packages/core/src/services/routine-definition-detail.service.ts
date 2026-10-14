import {z} from 'zod';
import {routineSourceRefSchema} from '../types/framework-version.types';
import {routineEnrollmentSchema, recordedRoutineEnrollmentSchema, type RecordedRoutineEnrollment, type RoutineEnrollment} from '../types/routine-definition.types';
import {requestInputDigest} from './test-request.service';
import {TestingDetailStorage, testingDetailPointerSchema} from './testing-detail-storage.service';
import {TestRunError} from './test-result-error';

export const ROUTINE_COLLECTION_BATCH_SIZE = 8;

export const routineCollectionDetailSchema = z.object({commit: z.string().regex(/^[a-f0-9]{40}$/),
  version: z.number().int().positive(), definitions: z.array(recordedRoutineEnrollmentSchema)}).strict();
export const routineCollectionManifestSchema = z.object({commit: z.string().regex(/^[a-f0-9]{40}$/),
  version: z.number().int().positive(), definitions: z.array(z.object({routineId: z.string(), platform: z.string(),
    definitionRevision: z.string(), definitionSha256: z.string(), routineSource: routineSourceRefSchema.optional(),
    detail: testingDetailPointerSchema}).strict()).max(1000)}).strict();

/** Collection metadata stays bounded; exact definitions retain separate verified objects. */
export async function writeRoutineCollection(input: z.infer<typeof routineCollectionDetailSchema>, storage = new TestingDetailStorage()) {
  const collection = routineCollectionDetailSchema.parse(input);
  const definitions = [];
  for (let offset = 0; offset < collection.definitions.length; offset += ROUTINE_COLLECTION_BATCH_SIZE) {
    const batch = await Promise.allSettled(collection.definitions.slice(offset, offset + ROUTINE_COLLECTION_BATCH_SIZE)
      .map(row => writeRecordedRoutineDefinition(row, storage)));
    for (const result of batch) {
      if (result.status === 'rejected') throw result.reason;
      const {card: _card, ...identity} = result.value;
      definitions.push(identity);
    }
  }
  const detail = await storage.write('collection', collection.commit, routineCollectionManifestSchema.parse({...collection, definitions}));
  return {detail, definitions};
}

export async function readRoutineCollection(pointer: unknown, storage = new TestingDetailStorage()) {
  const manifest = await storage.read(pointer, routineCollectionManifestSchema), definitions = [];
  for (let offset = 0; offset < manifest.definitions.length; offset += ROUTINE_COLLECTION_BATCH_SIZE)
    definitions.push(...await Promise.all(manifest.definitions.slice(offset, offset + ROUTINE_COLLECTION_BATCH_SIZE).map(row => readRoutineDefinition(row, storage))));
  return routineCollectionDetailSchema.parse({...manifest, definitions});
}

export function routineDefinitionProjection(row: RecordedRoutineEnrollment, detail: unknown) {
  const {definition, ...identity} = row;
  return {...identity, detail, card: {title: definition.title, purpose: definition.purpose,
    ...(definition.glasses ? {glasses: {models: z.object({models: z.array(z.string())}).passthrough().parse(definition.glasses).models}} : {})}};
}

export async function writeRoutineDefinition(row: RoutineEnrollment, storage = new TestingDetailStorage()) {
  const {verification: _verification, ...value} = routineEnrollmentSchema.parse(row);
  return writeRecordedRoutineDefinition(value, storage);
}

export async function writeRecordedRoutineDefinition(input: RecordedRoutineEnrollment, storage = new TestingDetailStorage()) {
  const {routineSource, ...original} = recordedRoutineEnrollmentSchema.parse(input);
  const value = {...original, ...(routineSource ? {routineSource} : {})}, row = value;
  if (requestInputDigest(value.definition) !== row.definitionSha256) throw new TestRunError(503, 'Routine definition digest differs');
  const detail = await storage.write('definition', `${row.routineId}:${row.platform}:${row.definitionRevision}`, value);
  return routineDefinitionProjection(row, detail);
}

export async function readRoutineDefinition(row: {routineId: string; platform: string; definitionRevision: string;
  definitionSha256: string; routineSource?: unknown; detail: unknown}, storage = new TestingDetailStorage()): Promise<RecordedRoutineEnrollment> {
  const value = await storage.read(row.detail, recordedRoutineEnrollmentSchema);
  if (value.routineId !== row.routineId || value.platform !== row.platform || value.definitionRevision !== row.definitionRevision ||
    value.definitionSha256 !== row.definitionSha256 || requestInputDigest(value.definition) !== row.definitionSha256 ||
    requestInputDigest(value.routineSource ?? null) !== requestInputDigest(row.routineSource ?? null))
    throw new TestRunError(503, 'Stored routine definition identity differs');
  return value;
}
