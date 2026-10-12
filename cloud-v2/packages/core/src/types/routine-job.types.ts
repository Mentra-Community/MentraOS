import {z} from 'zod';
import {frameworkIdentitySchema} from './framework-request.types';
import {routineSourceRefSchema} from './framework-version.types';
import {publishedRoutineDefinitionSchema, routineResourceRequirementSchema, routinePlatformSchema,
  glassesModelSchema, routineIdentitySchema} from './routine-definition.types';
import {routineDispatchSelectionSchema, routinePreparedBuildSchema, routineRevisionSchema} from './routine-dispatch.types';

export const jobHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const routineJobTargetSchema = z.object({hostId: frameworkIdentitySchema.optional(), laneId: frameworkIdentitySchema.optional()}).strict()
  .refine(value => !!value.hostId, 'A lane target requires its host identity');
export const routineJobSubmissionSchema = routineDispatchSelectionSchema.extend({target: routineJobTargetSchema.optional(),
  deadline: z.string().datetime({offset: true}).optional()}).refine(value => !value.routineRevision || !value.routineSource ||
    value.routineRevision === value.routineSource.commit, 'Routine revision and source must identify the same commit');
export const portableRoutineSelectionSchema = routineDispatchSelectionSchema.extend({routineRevision: routineRevisionSchema,
  build: routinePreparedBuildSchema}).refine(value => !value.routineSource || value.routineRevision === value.routineSource.commit,
    'Routine revision and source must identify the same commit').refine(value =>
    value.build.kind === (value.platform === 'android' ? 'android-apk' : 'mac-ci-package') &&
    JSON.stringify(value.build.source) === JSON.stringify(value.source), 'Frozen app source differs from selection');
export const portableRequirementsSchema = z.object({platform: routinePlatformSchema,
  glasses: z.object({models: z.array(glassesModelSchema).min(1).max(30), capabilities: z.array(routineIdentitySchema).max(30)}).strict().optional(),
  resources: z.array(routineResourceRequirementSchema).min(1).max(9)}).strict().superRefine((value, ctx) => {
    if (new Set(value.resources.map(resource => resource.kind)).size !== value.resources.length ||
      value.glasses && (new Set(value.glasses.models).size !== value.glasses.models.length ||
        new Set(value.glasses.capabilities).size !== value.glasses.capabilities.length) ||
      Boolean(value.glasses) !== value.resources.some(resource => resource.kind === 'glasses'))
      ctx.addIssue({code: 'custom', message: 'Portable requirements need unique kinds and consistent glasses requirements'});
  });
export const routineJobPreparationSchema = z.object({routineSource: routineSourceRefSchema, definitionSha256: jobHashSchema,
  definition: publishedRoutineDefinitionSchema, requirements: portableRequirementsSchema}).strict();
export const completeRoutineJobPreparationSchema = routineJobPreparationSchema.omit({requirements: true}).extend({inputSha256: jobHashSchema});
export const routineJobBindingSchema = z.object({jobId: frameworkIdentitySchema, requestId: frameworkIdentitySchema,
  hostId: frameworkIdentitySchema, laneId: frameworkIdentitySchema, descriptorRevision: jobHashSchema,
  actionsRunId: z.string().regex(/^[1-9][0-9]{0,19}$/), actionsJobId: z.string().regex(/^[1-9][0-9]{0,19}$/),
  boundAt: z.string().datetime({offset: true})}).strict();
export const routineJobBindInputSchema = routineJobBindingSchema.pick({laneId: true, descriptorRevision: true, actionsRunId: true, actionsJobId: true})
  .extend({inputSha256: jobHashSchema});
export const routinePublicationFailureSchema = z.object({entityId: frameworkIdentitySchema,
  payloadSha256: jobHashSchema, manifestSha256: jobHashSchema, operation: z.literal('result-create'),
  status: z.literal(409), code: z.literal('result_conflict'), message: z.string().min(1).max(1024),
  rejectedAt: z.string().datetime({offset: true})}).strict();
export const routineJobCompletionSchema = z.object({inputSha256: jobHashSchema, disposition: z.enum(['clean', 'repair']),
  completedAt: z.string().datetime({offset: true})}).strict();
export const routineJobCompletionReportSchema = routineJobCompletionSchema.extend({publicationFailure: routinePublicationFailureSchema.optional()}).strict();
export const routineJobActionsSchema = z.object({inputSha256: jobHashSchema, actionsRunId: z.string().regex(/^[1-9][0-9]{0,19}$/)}).strict();
export type RoutinePublicationFailure = z.infer<typeof routinePublicationFailureSchema>;
export type RoutineJobCompletion = z.infer<typeof routineJobCompletionSchema>;
export type PortableRoutineSelection = z.infer<typeof portableRoutineSelectionSchema>;
export type PortableRequirements = z.infer<typeof portableRequirementsSchema>;
export type RoutineJobPreparation = z.infer<typeof routineJobPreparationSchema>;
export type RoutineJobBinding = z.infer<typeof routineJobBindingSchema>;
export interface StoredRoutineJob {
  requestId: string;
  state: 'awaiting-source' | 'awaiting-runner' | 'preparing' | 'queued' | 'accepted' | 'running' | 'terminal';
  fleetSelection: PortableRoutineSelection;
  fleetSelectionSha256: string;
  fleetPreparation?: RoutineJobPreparation;
  fleetInputSha256?: string;
  fleetDeadline: Date;
  fleetTarget?: z.infer<typeof routineJobTargetSchema>;
  fleetBinding?: RoutineJobBinding;
  dispatchCompletion?: RoutineJobCompletion;
  publicationFailure?: RoutinePublicationFailure;
  hostReceipt?: import('../services/test-request.service').HostAcceptance;
  fleetDispatch?: import('../services/routine-job-actions.service').RoutineActionsDispatch;
  fleetActionsCancellation?: import('../services/routine-job-actions.service').RoutineActionsCancellation;
  fleetActions?: Array<{actionsRunId: string; recordedAt: string}>;
  fleetCancellation?: {requestedAt: string; reason: string};
  hostId?: string;
  /** Retained executable input digest after host-specific preparation. */
  inputSha256?: string;
  dispatchIntent?: unknown;
  dispatchIntentSha256?: string;
  preparation?: {code: string; reason: string; observedAt: string};
  preparationCancellation?: {requestedAt: string; reason: string};
  preparationRejection?: {code: string; reason: string};
  hostCancellation?: {requestedAt: string; reason: string};
  hostRejection?: {code: string; reason: string};
  terminalStatus?: string;
  runId?: string;
  createdAt?: Date;
}
