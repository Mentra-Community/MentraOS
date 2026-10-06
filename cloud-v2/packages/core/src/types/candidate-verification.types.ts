import {z} from 'zod'

/** Registration/admission metadata; it never enters immutable definition bytes. */
export const candidateVerificationSchema = z.object({
  workId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/),
  attemptId: z.number().int().positive().safe(),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
}).strict()
export type CandidateVerification = z.infer<typeof candidateVerificationSchema>
