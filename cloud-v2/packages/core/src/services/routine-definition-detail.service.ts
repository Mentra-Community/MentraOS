import {z} from 'zod';
import {routineEnrollmentSchema, type RoutineEnrollment} from '../types/routine-definition.types';
import {requestInputDigest} from './test-request.service';
import {TestingDetailStorage} from './testing-detail-storage.service';
import {TestRunError} from './test-result-error';

export const routineCollectionDetailSchema = z.object({commit: z.string().regex(/^[a-f0-9]{40}$/),
  version: z.number().int().positive(), definitions: z.array(routineEnrollmentSchema)}).strict();

export function routineDefinitionProjection(row: RoutineEnrollment, detail: unknown) {
  const {verification: _verification, definition, ...identity} = row;
  return {...identity, detail, card: {title: definition.title, purpose: definition.purpose,
    ...(definition.glasses ? {glasses: {models: definition.glasses.models}} : {})}};
}

export async function writeRoutineDefinition(row: RoutineEnrollment, storage = new TestingDetailStorage()) {
  const {verification: _verification, ...value} = row;
  if (requestInputDigest(value.definition) !== row.definitionSha256) throw new TestRunError(503, 'Routine definition digest differs');
  const detail = await storage.write('definition', `${row.routineId}:${row.platform}:${row.definitionRevision}`, value);
  return routineDefinitionProjection(row, detail);
}

export async function readRoutineDefinition(row: {routineId: string; platform: string; definitionRevision: string;
  definitionSha256: string; routineSource: unknown; detail: unknown}, storage = new TestingDetailStorage()): Promise<RoutineEnrollment> {
  const value = await storage.read(row.detail, routineEnrollmentSchema);
  if (value.routineId !== row.routineId || value.platform !== row.platform || value.definitionRevision !== row.definitionRevision ||
    value.definitionSha256 !== row.definitionSha256 || requestInputDigest(value.definition) !== row.definitionSha256 ||
    requestInputDigest(value.routineSource) !== requestInputDigest(row.routineSource))
    throw new TestRunError(503, 'Stored routine definition identity differs');
  return value;
}
