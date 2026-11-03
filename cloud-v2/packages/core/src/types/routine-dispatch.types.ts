import {appRepositorySchema} from './testing-source.types'
import {z} from 'zod';
import {frameworkBuildSchema, frameworkIdentitySchema} from './framework-request.types';
import {frameworkBindingSchema, frameworkVersionSchema, routineSourceRefSchema} from './framework-version.types';
import {routineIdentitySchema, routinePlatformSchema} from './routine-definition.types';
import {testBuildSourceSchema} from './test-build.types';
import {testingRepositorySchema} from './testing-source.types';

export const routineRevisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const routineDispatchSelectionSchema = z.object({requestId: frameworkIdentitySchema, routineId: routineIdentitySchema,
  platform: routinePlatformSchema, routineRevision: routineRevisionSchema.optional(), routineRepository: testingRepositorySchema.optional(),
  minimumFrameworkVersion: frameworkVersionSchema.optional(), routineSource: routineSourceRefSchema.optional(),
  source: testBuildSourceSchema}).strict();
export const consistentRoutineSource = (value: {routineRepository?: string; routineRevision?: string; routineSource?: {repository: string; commit: string}}) =>
  (!value.routineRevision || !value.routineSource || value.routineRevision === value.routineSource.commit) &&
  (!value.routineRepository || !value.routineSource || value.routineRepository === value.routineSource.repository);
export const routineDispatchSchema = routineDispatchSelectionSchema.refine(consistentRoutineSource, 'Routine repository, revision and source must identify the same commit');
const asset = z.object({url: z.string().url().refine(value => {const url = new URL(value);
  return url.origin === 'https://artifactscdn.mentraglass.com' && !url.username && !url.password && !url.hash;}),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive().safe()}).passthrough();
export const routinePreparedBuildSchema = frameworkBuildSchema.and(z.object({repository: appRepositorySchema,
  kind: z.enum(['mac-ci-package', 'android-apk']), source: testBuildSourceSchema,
  archive: asset.extend({name: z.string().min(1)}), receipt: asset}).passthrough()).refine(value => value.repository === (value.source.repository ?? 'Mentra-Community/MentraOS'),
    'Frozen app repository differs from its selected source');
export const routineDispatchIntentSchema = routineDispatchSelectionSchema.extend({routineRevision: routineRevisionSchema, laneId: frameworkIdentitySchema,
  build: routinePreparedBuildSchema})
  .refine(consistentRoutineSource, 'Routine repository, revision and source must identify the same commit')
  .refine(value => value.build.channel === value.source.channel && JSON.stringify(value.build.source) === JSON.stringify(value.source) &&
    value.build.kind === (value.platform === 'android' ? 'android-apk' : 'mac-ci-package'), 'Frozen app references contradict selected source or platform');
export type RoutineDispatchIntent = z.infer<typeof routineDispatchIntentSchema>;

export const preparationStatusSchema = z.object({dispatchIntentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  frameworkBinding: frameworkBindingSchema.optional(),
  code: frameworkIdentitySchema, reason: z.string().min(1).max(2000), observedAt: z.string().datetime({offset: true})}).strict();
export const preparationRejectionSchema = preparationStatusSchema.omit({observedAt: true})
  .extend({rejectedAt: z.string().datetime({offset: true}), disposition: z.enum(['not-run', 'not-applicable'])});

/** Bounded reconciliation of one framework-floor observation; request state still owns its effect. */
export const preparationFrameworkEffectSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('complete'), inputSha256: z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  z.object({kind: z.literal('reject'), rejectionSha256: z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
]);
export const preparationFrameworkAdmissionSchema = z.object({requestId: frameworkIdentitySchema,
  dispatchIntentSha256: z.string().regex(/^[a-f0-9]{64}$/), effect: preparationFrameworkEffectSchema,
  requestFenceSha256: z.string().regex(/^[a-f0-9]{64}$/), binding: frameworkBindingSchema,
  incarnation: frameworkIdentitySchema, incarnationGeneration: z.number().int().positive().safe(), sequence: z.number().int().nonnegative().safe(),
  deploymentGeneration: z.number().int().nonnegative().safe().optional(), deploymentSequence: z.number().int().nonnegative().safe().optional(),
  receivedAt: z.string().datetime({offset: true}), observedAt: z.string().datetime({offset: true}), admittedAt: z.string().datetime({offset: true}),
}).strict();
export type PreparationFrameworkEffect = z.infer<typeof preparationFrameworkEffectSchema>;
export type PreparationFrameworkAdmission = z.infer<typeof preparationFrameworkAdmissionSchema>;
