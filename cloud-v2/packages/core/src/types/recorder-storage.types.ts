import {z} from 'zod'

/** Capacity is a measured attribute of the existing recorder resource, shared by a host's lanes. */
export const STORAGE_MARGIN_BYTES = 2 * 1024 ** 3
export const STORAGE_OBSERVATION_MAX_AGE_MS = 120_000
const bytes = z.number().int().nonnegative().safe()
export const recorderStorageRequirementSchema = z.object({minimumAvailableBytes: bytes}).strict()
export const recorderStorageObservationSchema = z.object({poolId: z.string().min(1).max(240),
  observedAt: z.string().datetime(), availableBytes: bytes, stagingBudgetBytes: bytes, pendingEvidenceBytes: bytes,
  reservations: z.array(z.object({requestId: z.string().min(1).max(240), inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
    remainingOutputBytes: bytes}).strict()).max(1000),
}).strict().refine(value => new Set(value.reservations.map(row => row.requestId)).size === value.reservations.length,
  'Recorder storage reservations must have unique request identities')
export type RecorderStorageObservation = z.infer<typeof recorderStorageObservationSchema>
export function recorderStorageAvailable(observation: RecorderStorageObservation | undefined,
  requirement: z.infer<typeof recorderStorageRequirementSchema>, now: number, unobservedOutputBytes = 0) {
  const parsed = recorderStorageObservationSchema.safeParse(observation)
  if (!parsed.success || !Number.isFinite(now) || !recorderStorageRequirementSchema.safeParse(requirement).success ||
    !Number.isSafeInteger(unobservedOutputBytes) || unobservedOutputBytes < 0) return false
  const value = parsed.data, at = Date.parse(value.observedAt)
  if (at > now || now - at > STORAGE_OBSERVATION_MAX_AGE_MS) return false
  const reserved = value.reservations.reduce((total, row) => total + row.remainingOutputBytes, unobservedOutputBytes)
  return Number.isSafeInteger(reserved) && value.availableBytes >= requirement.minimumAvailableBytes + reserved &&
    value.stagingBudgetBytes >= value.pendingEvidenceBytes + reserved + Math.max(0, requirement.minimumAvailableBytes - STORAGE_MARGIN_BYTES)
}
