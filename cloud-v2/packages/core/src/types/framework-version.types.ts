import {z} from 'zod'

/** Published canonical-main first-parent commit count, independent from routine API numbering. */
export const frameworkVersionSchema = z.number().int().positive().safe()
export type FrameworkVersion = z.infer<typeof frameworkVersionSchema>

/** Actual installed framework at execution start; never part of the moving queued input. */
export const frameworkBindingSchema = z.object({
  version: frameworkVersionSchema,
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  installationId: z.string().min(1).max(240),
  configurationSha256: z.string().regex(/^[a-f0-9]{64}$/),
  runtimeSha256: z.string().regex(/^[a-f0-9]{64}$/),
  routineApiVersion: z.number().int().positive().safe(),
  publicApiSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export type FrameworkBinding = z.infer<typeof frameworkBindingSchema>

export const ROUTINE_BUNDLE_BODY_BYTES = 256 * 1024 ** 2
/** Exact routine-owned source and its declared public API requirement. */
export const routineSourceRefSchema = z.object({
  repository: z.literal('Mentra-Community/Mentra-Automated-Testing'),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  bundle: z.object({
    url: z.string().url().refine(value => {const url=new URL(value); return url.protocol==='https:' && !url.username && !url.password && !url.hash}, 'Routine archive requires HTTPS without embedded credentials'),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().positive().max(ROUTINE_BUNDLE_BODY_BYTES).safe(),
  }).strict(),
  minimumRoutineApiVersion: z.number().int().positive().safe(),
}).strict()
export type RoutineSourceRef = z.infer<typeof routineSourceRefSchema>
