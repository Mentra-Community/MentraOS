import {z} from 'zod'
import {frameworkIdentitySchema} from './framework-request.types'
import {frameworkHistoryEntrySchema, frameworkProcessSchema} from './lane-restoration.types'

/** Core copies its authenticated updater stop and accepted controller history
 * into the original return journal. This is never accepted from a return caller. */
export const resourceReturnContinuationSchema = z.object({
  hostId: frameworkIdentitySchema,
  stopped: z.object({installationId: frameworkIdentitySchema, process: frameworkProcessSchema,
    observedAt: z.string().datetime({offset: true})}).strict(),
  history: z.array(frameworkHistoryEntrySchema).min(2).max(100),
}).strict()
export type ResourceReturnContinuation = z.infer<typeof resourceReturnContinuationSchema>
