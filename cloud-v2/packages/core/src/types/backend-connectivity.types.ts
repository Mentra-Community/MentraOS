import {z} from 'zod'
import {frameworkBindingSchema, type FrameworkBinding} from './framework-version.types'
import {permissionBuildSchema} from './resource-permissions.types'

const identity = z.string().min(1).max(240)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const timestamp = z.string().datetime({offset: true})
export const backendQualificationPurposeSchema = z.object({kind: z.literal('backend-connectivity'), resourceId: identity}).strict()
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
  bootId: z.string().uuid().nullable(), tool: z.object({path: z.string().min(1).max(4096).startsWith('/'), sha256: hash}).strict(),
  check: z.object({operationId: identity, resultSha256: hash, readersSha256: hash, closedAt: timestamp}).strict(),
  releasedGeneration: z.number().int().positive().safe(), appRouteVerified: z.literal(false),
}).strict().refine(value => value.outcome !== 'qualified' || value.bootId !== null,
  'Qualified backend health requires the observed same-boot phone identity')
export type BackendConnectivityObservation = z.infer<typeof backendConnectivityObservationSchema>
export const BACKEND_CONNECTIVITY_MAX_AGE_MS = 120_000
export const BACKEND_CONNECTIVITY_ROUTINE_API_VERSION = 61
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

/** Fresh capability health is independent from physical idle and repair qualification. */
export function backendConnectivityObservationMatches(observation: BackendConnectivityObservation | undefined, resourceId: string,
  context: {now: number; binding: FrameworkBinding; app?: z.infer<typeof permissionBuildSchema>; backend?: BackendConnectivityContext}) {
  const parsed = backendConnectivityObservationSchema.safeParse(observation)
  if (!parsed.success || !context.app || !context.backend) return false
  const value = parsed.data, at = Date.parse(value.observedAt), closed = Date.parse(value.check.closedAt)
  return value.outcome === 'qualified' && value.phoneResourceId === resourceId &&
    at <= context.now && context.now - at <= BACKEND_CONNECTIVITY_MAX_AGE_MS && closed >= at && closed <= context.now &&
    context.binding.routineApiVersion >= BACKEND_CONNECTIVITY_ROUTINE_API_VERSION && sameIdentity(value.binding, context.binding) &&
    sameIdentity(value.app, context.app) && value.controller.incarnation === context.backend.incarnation &&
    value.controller.generation === context.backend.generation && context.backend.resourceGenerations.some(resource =>
      resource.resourceId === resourceId && resource.current && resource.unowned && resource.generation === value.releasedGeneration)
}
