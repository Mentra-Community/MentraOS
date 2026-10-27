import {z} from 'zod'
import {frameworkBindingSchema, type FrameworkBinding} from './framework-version.types'
import {permissionBuildSchema} from './resource-permissions.types'
import {candidateVerificationSchema} from './candidate-verification.types'

const identity = z.string().min(1).max(240)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const timestamp = z.string().datetime({offset: true})
/** The installed authenticated controller asserts one immutable pre-admission local operation. */
export const backendLocalPrerequisiteSchema = z.object({operationId: identity, requestedAt: timestamp,
  inputSha256: hash, definitionSha256: hash, admissionExpiresAt: z.number().int().positive().max(8_640_000_000_000_000).safe(),
  controller: z.object({incarnation: identity, generation: z.number().int().positive().safe()}).strict(),
  authority: z.discriminatedUnion('kind', [z.object({kind: z.literal('operator')}).strict(),
    z.object({kind: z.literal('candidate'), verification: candidateVerificationSchema,
      installerReceiptSha256: hash, completionOperationId: identity}).strict()]),
}).strict()
export type BackendLocalPrerequisite = z.infer<typeof backendLocalPrerequisiteSchema>
export const backendPreparingReceiptSchema = z.object({dispatchIntentSha256: hash, fleetInputSha256: hash,
  bindingSha256: hash, admissionSha256: hash, reservationSha256: hash}).strict()
export const backendCandidatePrerequisiteSchema = z.object({attemptId: identity, requestedAt: timestamp,
  fleetInputSha256: hash, selectionSha256: hash,
  previousAttemptId: identity.optional(),
  controller: z.object({incarnation: identity, generation: z.number().int().positive().safe()}).strict(),
}).strict()
export type BackendCandidatePrerequisite = z.infer<typeof backendCandidatePrerequisiteSchema>
/** Immutable physical subjects checked by one existing pre-binding candidate. */
export const resourceReadinessMemberSchema = z.object({id: identity,
  kind: z.enum(['phone', 'app', 'glasses', 'recorder', 'fixture-data', 'audio', 'browser']), authorityHostId: identity,
  subjectGeneration: z.number().int().nonnegative().safe(), contractVersion: identity,
  capabilities: z.array(identity).max(30)}).strict()
export const resourceReadinessMembersSchema = z.array(resourceReadinessMemberSchema).min(1).max(30)
  .refine(values => new Set(values.map(value => value.id)).size === values.length &&
    values.every(value => new Set(value.capabilities).size === value.capabilities.length), 'Readiness graph subjects and capabilities must be unique')
export const resourceReadinessPurposeSchema = z.object({kind: z.literal('resource-readiness'), resourceId: identity,
  resources: resourceReadinessMembersSchema}).strict().refine(value => value.resources[0]!.id === value.resourceId,
    'Readiness graph primary subject must identify its first frozen member')
export type ResourceReadinessMember = z.infer<typeof resourceReadinessMemberSchema>
export type ResourceReadinessPurpose = z.infer<typeof resourceReadinessPurposeSchema>
export const backendPrerequisiteOrigin = (value: {preparing?: unknown; local?: unknown; candidate?: unknown}) =>
  [value.preparing, value.local, value.candidate].filter(Boolean).length === 1
export const backendQualificationPurposeSchema = z.union([
  z.object({kind: z.literal('backend-connectivity'), resourceId: identity}).strict(), resourceReadinessPurposeSchema,
])
export const backendConnectivityTargetSchema = z.object({schemaVersion: z.literal(1), coreUrl: z.string().url().max(4096)}).strict()
  .refine(value => {
    const url = new URL(value.coreUrl)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && url.pathname === '/' &&
      !url.search && !url.hash && url.hostname.length <= 253 && url.hostname.includes('.') &&
      url.hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
  }, 'Backend target requires a credential-free HTTPS origin on its default port')

/** A bounded phone TCP/default-route observation, never app HTTP, CDN or download proof. */
export const backendConnectivityObservationSchema = z.object({schemaVersion: z.literal(1),
  capability: z.literal('backend-connectivity'), outcome: z.enum(['qualified', 'unqualified', 'unknown']), observedAt: timestamp,
  phoneResourceId: identity, binding: frameworkBindingSchema,
  controller: z.object({incarnation: identity, generation: z.number().int().positive().safe()}).strict(),
  app: permissionBuildSchema, target: backendConnectivityTargetSchema, targetSource: z.literal('verified-apk-configuration'),
  qualification: z.object({jobId: identity, targetInputSha256: hash, inputSha256: hash, preparing: backendPreparingReceiptSchema.optional(), local: backendLocalPrerequisiteSchema.optional(), candidate: backendCandidatePrerequisiteSchema.optional()
  }).strict().refine(backendPrerequisiteOrigin, 'Qualification requires exactly one original cloud or local intent').optional(),
  bootId: z.string().uuid().nullable(), tool: z.object({path: z.string().min(1).max(4096).startsWith('/'), sha256: hash}).strict(),
  check: z.object({operationId: identity, resultSha256: hash, readersSha256: hash, closedAt: timestamp}).strict(),
  releasedGeneration: z.number().int().positive().safe(), appRouteVerified: z.literal(false),
}).strict().refine(value => value.outcome !== 'qualified' || value.bootId !== null,
  'Qualified backend health requires the observed same-boot phone identity')
export type BackendConnectivityObservation = z.infer<typeof backendConnectivityObservationSchema>
export const resourceReadinessCheckSchema = z.object({resourceId: identity, checkOperationId: identity,
  outcome: z.enum(['passed', 'failed', 'unknown']), subjectGeneration: z.number().int().nonnegative().safe(),
  contractVersion: identity, resultSha256: hash, checkedAt: timestamp,
  backendConnectivity: backendConnectivityObservationSchema.optional()}).strict()
export type ResourceReadinessCheck = z.infer<typeof resourceReadinessCheckSchema>
export const candidatePrerequisiteSettlementSchema = z.object({targetInputSha256: hash, candidate: backendCandidatePrerequisiteSchema,
  outcome: z.enum(['qualified', 'unqualified', 'unknown']), hostWorkSettled: z.literal(true), checkOperationId: identity.optional(),
  graphChecks: z.array(resourceReadinessCheckSchema).max(30).optional(),
  neverRequested: z.literal(true).optional(),
}).strict().refine(value => !value.graphChecks || new Set(value.graphChecks.map(check => check.resourceId)).size === value.graphChecks.length &&
  new Set(value.graphChecks.map(check => check.checkOperationId)).size === value.graphChecks.length,
  'Readiness settlement must identify unique original physical checks').refine(value => !value.graphChecks || !!value.checkOperationId &&
    (value.graphChecks.length > 0 || value.outcome === 'unknown') &&
    (value.outcome !== 'qualified' || value.graphChecks.every(check => check.outcome === 'passed')),
  'A qualified graph needs its original parent and passing member checks').refine(value => !value.neverRequested ||
    value.outcome === 'unknown' && !!value.checkOperationId && value.graphChecks?.length === 0,
  'Never-requested closure requires the original graph parent and no checks')
export type CandidatePrerequisiteSettlement = z.infer<typeof candidatePrerequisiteSettlementSchema>
export const BACKEND_CONNECTIVITY_MAX_AGE_MS = 120_000
export const BACKEND_CONNECTIVITY_ROUTINE_API_VERSION = 61
export const BACKEND_CANDIDATE_ROUTINE_API_VERSION = 70
export type BackendConnectivityContext = {hostId: string; incarnation: string; generation: number;
  resourceGenerations: {resourceId: string; generation: number; current: boolean; unowned: boolean}[]}

// These identities contain only parsed JSON fields. Keep the shared type usable
// by the Admin browser bundle while comparing every field independent of key order.
const sameIdentity = (left: object, right: object) => {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) :
    value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

export function currentBackendConnectivityObservation(observation: BackendConnectivityObservation | undefined, resourceId: string,
  context: {now: number; binding: FrameworkBinding; app?: z.infer<typeof permissionBuildSchema>; backend?: BackendConnectivityContext}) {
  const parsed = backendConnectivityObservationSchema.safeParse(observation)
  if (!parsed.success || !context.app || !context.backend) return undefined
  const value = parsed.data, at = Date.parse(value.observedAt), closed = Date.parse(value.check.closedAt)
  const current = value.phoneResourceId === resourceId &&
    at <= context.now && context.now - at <= BACKEND_CONNECTIVITY_MAX_AGE_MS && closed >= at && closed <= context.now &&
    context.binding.routineApiVersion >= BACKEND_CONNECTIVITY_ROUTINE_API_VERSION && sameIdentity(value.binding, context.binding) &&
    sameIdentity(value.app, context.app) && value.controller.incarnation === context.backend.incarnation &&
    value.controller.generation === context.backend.generation && context.backend.resourceGenerations.some(resource =>
      resource.resourceId === resourceId && resource.current && resource.unowned && resource.generation === value.releasedGeneration)
  return current ? value : undefined
}

/** Fresh capability health is independent from physical idle and repair qualification. */
export function backendConnectivityObservationMatches(observation: BackendConnectivityObservation | undefined, resourceId: string,
  context: Parameters<typeof currentBackendConnectivityObservation>[2]) {
  return currentBackendConnectivityObservation(observation, resourceId, context)?.outcome === 'qualified'
}

/** A settled negative can defer a new preparation, never authorize execution or move retained work. */
export function backendConnectivityObservationRefusesPreparation(observation: BackendConnectivityObservation | undefined, resourceId: string,
  context: Parameters<typeof currentBackendConnectivityObservation>[2]) {
  const value = currentBackendConnectivityObservation(observation, resourceId, context)
  return value?.outcome === 'unqualified' && value.bootId !== null && Boolean(value.qualification) &&
    value.check.operationId === `backend-prerequisite:${value.qualification?.targetInputSha256}`
}
