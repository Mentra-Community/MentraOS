import {z} from 'zod'
import {frameworkBindingSchema} from './framework-version.types'

/** Wire contract shared with Harness; provider semantics remain in its typed registry. */
export const resourcePermissionSchema = z.enum(['camera', 'microphone', 'bluetooth', 'location', 'local-network',
  'accessibility', 'event-posting', 'full-disk-access', 'screen-recording'])
export type ResourcePermission = z.infer<typeof resourcePermissionSchema>
export const permissionRequirementSchema = z.object({permission: resourcePermissionSchema,
  recipient: z.enum(['app', 'worker'])}).strict()
export type PermissionRequirement = z.infer<typeof permissionRequirementSchema>
export const permissionRequirementsSchema = z.array(permissionRequirementSchema).max(9)
  .refine(value => new Set(value.map(item => item.permission)).size === value.length, 'Permission requirements must be unique')
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const path = z.string().min(1).max(4096).startsWith('/')
const executable = z.object({path, sha256}).strict()
export const permissionBuildSchema = z.object({headSha: z.string().regex(/^[a-f0-9]{40}$/),
  archiveSha256: sha256, receiptSha256: sha256}).strict()
export const permissionRecipientSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('worker'), uid: z.number().int().nonnegative().safe(), runtime: executable, helper: executable}).strict(),
  z.object({kind: z.literal('app'), uid: z.number().int().nonnegative().safe(), pid: z.number().int().positive().safe(),
    processStartedAt: z.string().min(1).max(200), launchedAt: z.number().positive().finite(), bundleId: z.literal('com.mentra.mentra'),
    bundlePath: path, executablePath: path, version: z.string().min(1).max(80), build: z.string().min(1).max(80),
    teamId: z.string().min(1).max(80), codeRequirement: z.string().min(1).max(8192), selectedBuild: permissionBuildSchema}).strict(),
])
export const permissionObservationSchema = z.object({permission: resourcePermissionSchema,
  status: z.enum(['granted', 'denied', 'blocked', 'unavailable', 'unknown']), rawStatus: z.string().max(100).nullable(),
  observedAt: z.string().datetime(), binding: frameworkBindingSchema, recipient: permissionRecipientSchema,
  evidence: z.object({sha256}).strict(),
}).strict()
export type PermissionObservation = z.infer<typeof permissionObservationSchema>
export const permissionObservationsSchema = z.array(permissionObservationSchema).max(9)
  .refine(value => new Set(value.map(item => item.permission)).size === value.length, 'Permission observations must be unique')
export const PERMISSION_OBSERVATION_MAX_AGE_MS = 120_000

/** No missing, unknown, future, stale or wrong-recipient observation is a grant. */
export function permissionObservationMatches(observed: PermissionObservation | undefined, permission: ResourcePermission,
  context: {now: number; binding: z.infer<typeof frameworkBindingSchema>; app?: z.infer<typeof permissionBuildSchema>;
    recipient: 'worker' | 'app'}): boolean {
  const parsed = permissionObservationSchema.safeParse(observed)
  if (!parsed.success) return false
  const value = parsed.data, at = Date.parse(value.observedAt)
  if (value.permission !== permission || value.status !== 'granted' || at > context.now ||
    context.now - at > PERMISSION_OBSERVATION_MAX_AGE_MS || value.recipient.kind !== context.recipient ||
    Object.entries(context.binding).some(([key, expected]) => value.binding[key as keyof typeof value.binding] !== expected)) return false
  if (value.recipient.kind === 'worker') return value.recipient.runtime.sha256 === context.binding.runtimeSha256
  return Boolean(context.app && Object.entries(context.app).every(([key, expected]) =>
    value.recipient.kind === 'app' && value.recipient.selectedBuild[key as keyof typeof value.recipient.selectedBuild] === expected))
}

/** Selected artifacts come from the existing release authority; missing references cannot qualify an app. */
export function permissionContext(binding: z.infer<typeof frameworkBindingSchema> | undefined,
  build: {headSha: string; archive?: {sha256: string}; receipt?: {sha256: string}}, now: number) {
  if (!binding) return undefined
  const app = permissionBuildSchema.safeParse({headSha: build.headSha, archiveSha256: build.archive?.sha256,
    receiptSha256: build.receipt?.sha256})
  return {now, binding, ...(app.success ? {app: app.data} : {})}
}
