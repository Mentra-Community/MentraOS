import {z} from 'zod';
import {frameworkBuildSchema, frameworkIdentitySchema} from './framework-request.types';
import {frameworkVersionSchema, routineSourceRefSchema} from './framework-version.types';
import {routineIdentitySchema, routinePlatformSchema} from './routine-definition.types';
import {testBuildSourceSchema} from './test-build.types';

export const routineRevisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const routineDispatchSelectionSchema = z.object({requestId: frameworkIdentitySchema, routineId: routineIdentitySchema,
  platform: routinePlatformSchema, routineRevision: routineRevisionSchema.optional(),
  minimumFrameworkVersion: frameworkVersionSchema.optional(), routineSource: routineSourceRefSchema.optional(),
  source: testBuildSourceSchema}).strict();
const consistentSource = (value: {routineRevision?: string; routineSource?: {commit: string}}) =>
  !value.routineRevision || !value.routineSource || value.routineRevision === value.routineSource.commit;
export const routineDispatchSchema = routineDispatchSelectionSchema.refine(consistentSource, 'Routine revision and source must identify the same commit');
const asset = z.object({url: z.string().url().refine(value => {const url = new URL(value);
  return url.origin === 'https://artifactscdn.mentraglass.com' && !url.username && !url.password && !url.hash;}),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive().safe()}).passthrough();
export const routinePreparedBuildSchema = frameworkBuildSchema.and(z.object({repository: z.literal('Mentra-Community/MentraOS'),
  kind: z.enum(['mac-ci-package', 'android-apk']), source: testBuildSourceSchema,
  archive: asset.extend({name: z.string().min(1)}), receipt: asset}).passthrough());
export const routineDispatchIntentSchema = routineDispatchSelectionSchema.extend({routineRevision: routineRevisionSchema, laneId: frameworkIdentitySchema,
  build: routinePreparedBuildSchema})
  .refine(consistentSource, 'Routine revision and source must identify the same commit')
  .refine(value => value.build.channel === value.source.channel && JSON.stringify(value.build.source) === JSON.stringify(value.source) &&
    value.build.kind === (value.platform === 'android' ? 'android-apk' : 'mac-ci-package'), 'Frozen app references contradict selected source or platform');
export type RoutineDispatchIntent = z.infer<typeof routineDispatchIntentSchema>;

export const preparationStatusSchema = z.object({dispatchIntentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  code: frameworkIdentitySchema, reason: z.string().min(1).max(2000), observedAt: z.string().datetime({offset: true})}).strict();
export const preparationRejectionSchema = preparationStatusSchema.omit({observedAt: true})
  .extend({rejectedAt: z.string().datetime({offset: true}), disposition: z.enum(['not-run', 'not-applicable'])});
