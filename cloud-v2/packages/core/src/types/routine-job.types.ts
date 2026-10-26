import {z} from 'zod';
import {frameworkIdentitySchema, frameworkRequestInputSchema} from './framework-request.types';
import {frameworkBindingSchema, routineSourceRefSchema} from './framework-version.types';
import {publishedRoutineDefinitionSchema, routineResourceRequirementSchema, routinePlatformSchema,
  glassesModelSchema, routineIdentitySchema} from './routine-definition.types';
import {consistentRoutineSource, routineDispatchSelectionSchema, routinePreparedBuildSchema, routineRevisionSchema} from './routine-dispatch.types';
import {backendQualificationPurposeSchema, backendLocalPrerequisiteSchema, backendPreparingReceiptSchema, backendCandidatePrerequisiteSchema, backendConnectivityTargetSchema, candidatePrerequisiteSettlementSchema, backendPrerequisiteOrigin} from './backend-connectivity.types';
import {recorderHostReservationSchema} from './recorder-storage.types';
import {fleetResourceAdmissionSchema, fleetExclusiveReservationSchema} from './resource-reservations.types';
import {resourceReturnContinuationSchema} from './resource-return-continuation.types';

const canonicalTarget = (value: unknown): unknown => Array.isArray(value) ? value.map(canonicalTarget) :
  value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => [key, canonicalTarget(child)])) : value
// SHA validation is performed at the service boundary; this helper compares exact input identities here.
const canonicalTargetIdentity = (value: unknown) => JSON.stringify(canonicalTarget(value))
export const jobHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const routineJobTargetSchema = z.object({hostId: frameworkIdentitySchema.optional(), laneId: frameworkIdentitySchema.optional()}).strict()
  .refine(value => !!value.hostId, 'A lane target requires its host identity');
export const routineJobSubmissionSchema = routineDispatchSelectionSchema.extend({target: routineJobTargetSchema.optional(),
  deadline: z.string().datetime({offset: true}).optional()}).refine(consistentRoutineSource, 'Routine repository, revision and source must identify the same commit');
export const portableRoutineSelectionSchema = routineDispatchSelectionSchema.extend({routineRevision: routineRevisionSchema,
  build: routinePreparedBuildSchema}).refine(consistentRoutineSource,
    'Routine repository, revision and source must identify the same commit').refine(value =>
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
/** Read-only probe candidate; this is not a product binding or execution acknowledgement. */
export const routineQualificationTargetSchema = z.object({jobId: frameworkIdentitySchema, hostId: frameworkIdentitySchema,
  laneId: frameworkIdentitySchema, inputSha256: jobHashSchema, deadline: z.string().datetime({offset: true}),
  selection: portableRoutineSelectionSchema, requirements: portableRequirementsSchema,
  purpose: backendQualificationPurposeSchema.optional(),
  acceptedBinding: frameworkBindingSchema.optional(),
  proposedInput: frameworkRequestInputSchema.optional(),
  preparing: backendPreparingReceiptSchema.optional(), local: backendLocalPrerequisiteSchema.optional(),
  candidate: backendCandidatePrerequisiteSchema.optional(), definition: publishedRoutineDefinitionSchema.optional(), definitionSha256: jobHashSchema.optional(),
  accepted: z.object({requestId: frameworkIdentitySchema, hostId: frameworkIdentitySchema, inputSha256: jobHashSchema,
    acceptedAt: z.string().datetime({offset: true}), binding: frameworkBindingSchema,
    controller: z.object({incarnation: frameworkIdentitySchema, generation: z.number().int().positive().safe()}).strict()}).strict().optional(),
  target: routineJobTargetSchema.optional()}).strict().refine(value => value.selection.requestId === value.jobId &&
    (value.purpose ? !!value.acceptedBinding && backendPrerequisiteOrigin(value) && !!value.proposedInput && !value.accepted &&
      (value.purpose.kind === 'resource-readiness' ? !!value.candidate && !value.preparing && !value.local &&
        value.proposedInput.platform === value.selection.platform && value.proposedInput.laneId === value.laneId &&
        value.proposedInput.routineId === value.selection.routineId && value.proposedInput.definitionRevision === value.selection.routineRevision &&
        value.purpose.resources.every(member => member.authorityHostId === value.hostId) &&
        value.proposedInput.resources.filter(resource => ['phone', 'app', 'glasses', 'recorder', 'fixture-data', 'audio', 'browser'].includes(resource.kind))
          .every(resource => value.purpose?.kind === 'resource-readiness' && value.purpose.resources.some(member => member.id === resource.id && member.kind === resource.kind)) :
        value.selection.platform === 'android' && value.requirements.resources.some(resource => resource.kind === 'phone' && resource.capabilities.includes('backend-connectivity')))
      : value.selection.platform === 'ios-on-mac' && !value.acceptedBinding && !value.proposedInput && !value.local && !value.candidate) && value.requirements.platform === value.selection.platform &&
    (!value.target || value.target.hostId === value.hostId && (!value.target.laneId || value.target.laneId === value.laneId)) &&
    (!value.accepted || value.accepted.requestId === value.jobId && value.accepted.hostId === value.hostId) &&
    (!(value.preparing || value.local || value.candidate) || !value.accepted && value.target?.hostId === value.hostId && value.target.laneId === value.laneId),
  'Qualification target differs from its selected job, platform or explicit lane constraint').refine(value => value.candidate
    ? !!value.definition && !!value.definitionSha256 && Date.parse(value.candidate.requestedAt) < Date.parse(value.deadline)
    : !value.definition && !value.definitionSha256, 'Candidate requires its immutable declared definition').refine(value => !value.local ||
    value.proposedInput &&
    value.deadline === new Date(value.local.admissionExpiresAt).toISOString() &&
    Date.parse(value.local.requestedAt) < value.local.admissionExpiresAt &&
    Boolean(/^local:([0-9]{13}):([A-Za-z0-9_-]{1,120})$/.exec(value.jobId)) &&
    (value.local.authority.kind === 'operator' ? Number(value.jobId.split(':')[1]) === value.local.admissionExpiresAt :
      Number(value.jobId.split(':')[1]) <= value.local.admissionExpiresAt) &&
    value.proposedInput.platform === 'android' && value.proposedInput.laneId === value.laneId &&
    value.proposedInput.routineId === value.selection.routineId && value.proposedInput.definitionRevision === value.selection.routineRevision &&
    canonicalTargetIdentity(value.proposedInput.routineSource) === canonicalTargetIdentity(value.selection.routineSource) &&
    (value.local.authority.kind === 'candidate' ? canonicalTargetIdentity(value.proposedInput.verification) === canonicalTargetIdentity(value.local.authority.verification) : !value.proposedInput.verification),
  'Local prerequisite must retain its original admission input, authority and deadline');
/** One pre-binding probe on the existing request; retained through its exact normal return. */
export const fleetCandidatePreparationSchema = z.object({candidate: backendCandidatePrerequisiteSchema, hostId: frameworkIdentitySchema,
  laneId: frameworkIdentitySchema, target: routineQualificationTargetSchema, targetInputSha256: jobHashSchema,
  backendTarget: backendConnectivityTargetSchema.optional(),
  provisionalReturn: z.object({recorder: recorderHostReservationSchema, admission: fleetResourceAdmissionSchema.optional(),
    exclusive: fleetExclusiveReservationSchema.optional(), releasedAt: z.string().datetime({offset: true}).optional()}).strict().optional(),
  claimReceipt: z.unknown().optional(), returnReceipt: z.unknown().optional(), settlement: candidatePrerequisiteSettlementSchema.optional(),
  resourceClaims: z.array(z.unknown()).min(1).max(30).optional(), resourceReturns: z.array(z.unknown()).min(1).max(30).optional(),
  resourceReturnContinuation: resourceReturnContinuationSchema.optional(),
  noAcquisitionReceipt: z.unknown().optional(),
  coordinatorSupersession: z.object({kind: z.literal('controller-replaced'), at: z.string().datetime(),
    controller: z.object({incarnation: frameworkIdentitySchema, generation: z.number().int().positive().safe()}).strict()}).strict().optional(),
}).strict().refine(value => value.target.purpose?.kind === 'resource-readiness'
  ? !value.claimReceipt && !value.returnReceipt
  : !value.resourceClaims && !value.resourceReturns && !value.resourceReturnContinuation && !value.settlement?.graphChecks,
  'Graph and scalar candidate receipts cannot replace one another')
export type FleetCandidatePreparation = z.infer<typeof fleetCandidatePreparationSchema>
export const MAX_FLEET_CANDIDATE_PREPARATIONS = 20
export type RoutineQualificationTarget = z.infer<typeof routineQualificationTargetSchema>;
/** Exact passive owner lookup on the existing host-authenticated target read. */
export const ownedRoutineQualificationSchema = z.object({jobId: frameworkIdentitySchema, laneId: frameworkIdentitySchema,
  inputSha256: jobHashSchema, ownerId: frameworkIdentitySchema, generation: z.number().int().positive().safe(),
  binding: frameworkBindingSchema, controller: z.object({incarnation: frameworkIdentitySchema,
    generation: z.number().int().positive().safe()}).strict(), purpose: backendQualificationPurposeSchema.optional()}).strict();
export type OwnedRoutineQualification = z.infer<typeof ownedRoutineQualificationSchema>;
/** Original target lookup before acquisition; it supplies no owner or grant. */
export const unclaimedRoutineQualificationSchema = ownedRoutineQualificationSchema.pick({jobId: true, inputSha256: true});
export type UnclaimedRoutineQualification = z.infer<typeof unclaimedRoutineQualificationSchema>;
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
export const routinePreparationStatusSchema = z.object({inputSha256: jobHashSchema,
  actionsRunId: z.string().regex(/^[1-9][0-9]{0,19}$/),
  phase: z.enum(['workflow registration', 'source cleanup', 'selected archive', 'Git inventory', 'Git blobs', 'routine description', 'routine bundle',
    'bundle publication', 'prepared job commit', 'prepared job readback']),
  code: z.enum(['source-unavailable', 'source-invalid', 'not-applicable']), retryable: z.boolean(),
}).strict().refine(value => value.code === 'source-unavailable' ? value.retryable : !value.retryable,
  'Only unavailable source can retry');
export type RoutinePreparationStatus = z.infer<typeof routinePreparationStatusSchema> & {observedAt: string; reason: string};
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
  fleetPreparationStatus?: RoutinePreparationStatus;
  fleetInputSha256?: string;
  fleetDeadline: Date;
  fleetCandidateSelection?: {hostId: string; laneId: string; targetInputSha256: string};
  fleetCandidatePreparation?: FleetCandidatePreparation;
  fleetCandidatePreparations?: FleetCandidatePreparation[];
  fleetTarget?: z.infer<typeof routineJobTargetSchema>;
  fleetBinding?: RoutineJobBinding;
  /** Existing request authority retains the shared recorder capacity selected before device dispatch. */
  fleetResourceReservation?: import('./recorder-storage.types').RecorderHostReservation;
  fleetResourceAdmission?: import('./resource-reservations.types').FleetResourceAdmission;
  fleetExclusiveReservation?: import('./resource-reservations.types').FleetExclusiveReservation;
  fleetExclusiveExecutionBinding?: import('./resource-reservations.types').FleetExclusiveExecutionBinding;
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
