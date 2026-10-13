import {z} from 'zod'
import {frameworkIdentitySchema} from './framework-request.types'

const sha = z.string().regex(/^[a-f0-9]{40}$/)
export const caseIdSchema = z.string().regex(/^mfc_[a-f0-9]{64}$/)
export const caseClassificationSchema = z.enum(['app', 'framework', 'routine', 'undetermined'])
export const caseStageSchema = z.enum(['investigating', 'fixing', 'in-review', 'waiting-deployment', 'verifying', 'verified', 'needs-input'])
export const casePrSchema = z.object({repository: z.enum(['Mentra-Community/MentraOS', 'Mentra-Community/Mentra-Automated-Testing']),
  number: z.number().int().positive().safe()}).strict()
export const caseEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('run'), id: frameworkIdentitySchema}).strict(),
  z.object({kind: z.literal('incident'), id: z.string().regex(/^rep_[A-Za-z0-9]{1,80}$/)}).strict(),
  z.object({kind: z.literal('pull-request'), ...casePrSchema.shape}).strict(),
])
export const caseOriginalSchema = z.object({requestId: frameworkIdentitySchema.optional(), memberId: frameworkIdentitySchema.optional(),
  suiteId: frameworkIdentitySchema.optional(), runId: frameworkIdentitySchema.optional(), routineId: frameworkIdentitySchema.optional(),
  platform: z.string().min(1).max(80).optional(), environment: z.string().min(1).max(30), channel: z.enum(['dev', 'staging', 'pr', 'local']), repository: z.string().regex(/^[\w-]+\/[\w.-]+$/),
  branch: z.string().min(1).max(255), headSha: sha.optional(), branchKey: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum(['setup', 'test', 'teardown', 'evidence']).optional(), actionId: frameworkIdentitySchema.optional(),
}).strict()
export const caseOccurrenceSchema = z.object({occurrenceId: frameworkIdentitySchema, rootKey: z.string().regex(/^[a-f0-9]{64}$/),
  anchorRunId: frameworkIdentitySchema, original: caseOriginalSchema,
  closure: z.object({kind: z.enum(['verified', 'closed']), reason: z.string().trim().min(1).max(1000),
    requestId: frameworkIdentitySchema.optional(), at: z.string().datetime(), actor: z.string().max(300)}).strict().optional(),
  verificationRequestIds: z.array(frameworkIdentitySchema).max(100),
}).strict()
export const casePrObservationSchema = z.object({...casePrSchema.shape, headSha: sha,
  state: z.enum(['open', 'closed', 'merged']), review: z.enum(['approved', 'changes-requested', 'pending']),
  mergedAt: z.string().datetime().nullable(), observedAt: z.string().datetime(),
}).strict()
export const caseClaimSchema = z.object({owner: z.string().min(1).max(100), tokenSha256: z.string().regex(/^[a-f0-9]{64}$/),
  branchKey: z.string().regex(/^[a-f0-9]{64}$/), anchorRunId: frameworkIdentitySchema, generation: z.number().int().positive().safe(),
  expiresAt: z.string().datetime(), state: z.enum(['running', 'held'])}).strict()
export const routineCaseSchema = z.object({version: z.literal(2), caseId: caseIdSchema,
  revision: z.number().int().nonnegative().safe(), generation: z.number().int().nonnegative().safe(),
  classification: caseClassificationSchema, diagnosis: z.string().max(2000), evidence: z.array(caseEvidenceSchema).max(30),
  stage: caseStageSchema, nextAction: z.string().max(1000), owner: z.string().max(300).nullable(),
  input: z.object({question: z.string().min(1).max(1000), recipient: z.string().min(1).max(300)}).strict().optional(),
  occurrences: z.array(caseOccurrenceSchema).min(1).max(100).refine(rows =>
    new Set(rows.map(row => row.occurrenceId)).size === rows.length && new Set(rows.map(row => row.rootKey)).size === rows.length,
    'Duplicate canonical occurrence identity'), intendedFixes: z.array(casePrSchema).max(20),
  prObservations: z.array(casePrObservationSchema).max(20), claim: caseClaimSchema.optional(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  archive: z.object({key: z.string().max(500), sha256: z.string().regex(/^[a-f0-9]{64}$/), sizeBytes: z.number().int().positive()}).strict().optional(),
}).strict()
export type RoutineCase = z.infer<typeof routineCaseSchema>
export type CaseOccurrence = z.infer<typeof caseOccurrenceSchema>
export type CasePr = z.infer<typeof casePrSchema>
export type CaseActor = {kind: 'operator'; id: string} | {kind: 'agent'; id: string; token: string; generation: number; branchKey: string; anchorRunId: string}
export const caseMutationSchema = z.object({mutationId: z.string().uuid(), revision: z.number().int().nonnegative().safe(),
  classification: caseClassificationSchema.optional(), diagnosis: z.string().trim().max(2000).optional(),
  evidence: z.array(caseEvidenceSchema).max(30).optional(), stage: caseStageSchema.optional(), nextAction: z.string().trim().max(1000).optional(),
  owner: z.string().trim().min(1).max(300).nullable().optional(), input: routineCaseSchema.shape.input.nullable().optional(),
  intendedFixes: z.array(casePrSchema).max(20).optional(),
  verification: z.object({occurrenceId: frameworkIdentitySchema, requestId: frameworkIdentitySchema}).strict().optional(),
  close: z.object({occurrenceId: frameworkIdentitySchema, kind: z.enum(['verified', 'closed']),
    reason: z.string().trim().min(1).max(1000), requestId: frameworkIdentitySchema.optional()}).strict().optional(),
}).strict()
export type CaseMutation = z.infer<typeof caseMutationSchema>
export interface CaseActivity {caseId: string; revision: number; mutationId: string; digest: string;
  actor: string; at: string; kind: 'create' | 'update' | 'intended-fix' | 'claim' | 'release' | 'pr-observation' | 'migration';
  changed: string[]; detail?: {key: string; sha256: string; sizeBytes: number}}
export interface FailureFollowUp {case: Omit<RoutineCase, 'claim'> & {execution: {owner: string; generation: number; state: 'running' | 'held' | 'expired'} | null};
  activity: CaseActivity[]; nextBefore: number | null}

const claimOperation = {mutationId: z.string().uuid(), revision: z.number().int().nonnegative().safe(),
  generation: z.number().int().positive().safe(), branchKey: caseClaimSchema.shape.branchKey,
  anchorRunId: frameworkIdentitySchema, token: z.string().regex(/^[A-Za-z0-9_-]{32,200}$/)}
export const caseClaimOperationSchema = z.discriminatedUnion('action', [
  z.object({...claimOperation, action: z.literal('acquire'), ttlSeconds: z.number().int().min(30).max(900)}).strict(),
  z.object({...claimOperation, action: z.literal('renew'), ttlSeconds: z.number().int().min(30).max(900)}).strict(),
  z.object({...claimOperation, action: z.literal('hold'), reason: z.string().trim().min(1).max(1000)}).strict(),
  z.object({...claimOperation, action: z.literal('release'), reason: z.string().trim().min(1).max(1000)}).strict(),
])
