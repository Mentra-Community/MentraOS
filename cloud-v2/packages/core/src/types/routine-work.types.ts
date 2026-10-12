import {z} from 'zod'
import {frameworkIdentitySchema} from './framework-request.types'
import {routineIdentitySchema, routineResourceRequirementSchema} from './routine-definition.types'
import {routineJobTargetSchema, portableRequirementsSchema} from './routine-job.types'
import {testBuildSourceSchema} from './test-build.types'
import {firmwareManifestSchema} from './glasses-software.types'

const sha = z.string().regex(/^[a-f0-9]{40}$/)
export const workHashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const json: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.string(), z.number().finite(), z.array(json), z.record(json)]),
)
const boundedJson = (bytes: number) =>
  json.refine((value) => Buffer.byteLength(JSON.stringify(value)) <= bytes, 'JSON exceeds its byte limit')
const description = z.string().trim().min(1).max(2000)
const identifiers = z.array(routineIdentitySchema).max(30)
export const routineWorkRequirementsSchema = z
  .object({
    platform: z.enum(['mac', 'android']),
    glasses: identifiers,
    resources: z.array(routineResourceRequirementSchema).min(1).max(9),
    environment: z
      .array(z.object({provider: routineIdentitySchema, input: boundedJson(32 * 1024), description}).strict())
      .max(20),
  })
  .strict()
  .superRefine((value, ctx) => {
    const kinds = value.resources.map(resource => resource.kind), kindSet = new Set<string>(kinds)
    const base = ['app', 'recorder', ...(value.platform === 'android' ? ['phone'] : [])]
    if (kindSet.size !== kinds.length || !base.every(kind => kindSet.has(kind)) ||
      Boolean(value.glasses.length) !== kinds.includes('glasses') || new Set(value.glasses).size !== value.glasses.length)
      ctx.addIssue({code: 'custom', message: 'Authoring requires unique typed resources, its platform base and consistent glasses models'})
  })
export const routineWorkPortableRequirementsSchema = routineWorkRequirementsSchema
  .superRefine((value, ctx) => {
    const requirements = portableRequirementsSchema.safeParse({platform: value.platform === 'mac' ? 'ios-on-mac' : 'android',
      resources: value.resources,
      ...(value.glasses.length ? {glasses: {models: value.glasses, capabilities: value.resources.find(resource => resource.kind === 'glasses')?.capabilities ?? []}} : {})})
    if (!requirements.success)
      ctx.addIssue({code: 'custom', message: 'Authoring needs consistent portable fixture requirements'})
  })
const fields = {
  schemaVersion: z.literal(1),
  workId: frameworkIdentitySchema,
  kind: z.enum(['create', 'edit']),
  routineId: routineIdentitySchema,
  brief: z
    .object({
      goal: z.string().trim().min(1).max(4000),
      stepsOrChanges: z.array(description).min(1).max(100),
      expected: z.array(description).min(1).max(100),
    })
    .strict(),
  source: z.object({repository: z.literal('Mentra-Community/Mentra-Automated-Testing'), revision: sha}).strict(),
  target: z.object({hostId: frameworkIdentitySchema, laneId: frameworkIdentitySchema}).strict(),
  requirements: routineWorkRequirementsSchema,
  origin: z
    .object({
      repository: z.literal('Mentra-Community/MentraOS'),
      prNumber: z.number().int().positive().safe(),
      headSha: sha,
    })
    .strict(),
}
const pin = z.object({url: z.string().url(), sha256: workHashSchema, size: z.number().int().positive().safe()}).strict()
/** Matches the existing exact Mac/Android package selection; no local paths enter cloud intake. */
export const routineWorkBuildSchema = z
  .object({
    kind: z.enum(['mac-ci-package', 'android-apk']),
    repository: z.literal('Mentra-Community/MentraOS'),
    headSha: sha,
    channel: z.enum(['dev', 'staging', 'pr']),
    prNumber: z.number().int().positive().safe().optional(),
    releaseIdentity: z
      .string()
      .regex(/^\d+\.\d+\.\d+-(dev|beta)\.[1-9]\d*$/)
      .optional(),
    source: testBuildSourceSchema,
    archive: pin.extend({name: z.string().regex(/^[A-Za-z0-9._-]+\.(zip|apk)$/)}),
    receipt: pin,
    manifest: firmwareManifestSchema.optional(),
    manifestSha256: workHashSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.source.channel !== value.channel ||
      (value.channel === 'pr'
        ? value.source.channel !== 'pr' ||
          value.prNumber !== value.source.prNumber ||
          value.releaseIdentity !== undefined
        : value.prNumber !== undefined || !value.releaseIdentity)
    )
      ctx.addIssue({code: 'custom', message: 'Build source and channel differ'})
    if (
      (value.manifest === undefined) !== (value.manifestSha256 === undefined) ||
      (value.manifest && value.manifest.sha256 !== value.manifestSha256)
    )
      ctx.addIssue({code: 'custom', message: 'Build manifest digest differs'})
    if (!value.archive.name.endsWith(value.kind === 'android-apk' ? '.apk' : '.zip'))
      ctx.addIssue({code: 'custom', message: 'Build archive and platform differ'})
  })
export const routineWorkRequestSchema = z.object({...fields,
  source: fields.source.partial({revision: true}), target: routineJobTargetSchema.optional(),
  requirements: routineWorkPortableRequirementsSchema,
  buildSource: testBuildSourceSchema, deadline: z.string().datetime({offset: true}).optional(),
}).strict()
export const authoringWorkSchema = z
  .object({...fields, origin: fields.origin.optional(), build: routineWorkBuildSchema})
  .strict()
  .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 256 * 1024, 'Work envelope exceeds its byte limit')
  .refine(
    (value) => value.build.kind === (value.requirements.platform === 'mac' ? 'mac-ci-package' : 'android-apk'),
    'Build platform differs',
  )
export const portableAuthoringWorkSchema = z.object({...fields, target: routineJobTargetSchema.optional(),
  requirements: routineWorkPortableRequirementsSchema,
  build: routineWorkBuildSchema,
}).strict()
export type PortableAuthoringWork = z.infer<typeof portableAuthoringWorkSchema>
export type RoutineWorkRequest = z.infer<typeof routineWorkRequestSchema>
export type AuthoringWork = z.infer<typeof authoringWorkSchema>
export const routineWorkStateSchema = z.enum([
  'queued',
  'preparing',
  'waiting-for-lane',
  'authoring',
  'needs-input',
  'stopped',
  'awaiting-review',
  'awaiting-installation',
  'verifying',
  'passed',
  'failed',
  'cancelled',
])
export const routineWorkAcceptanceSchema = z
  .object({
    workId: frameworkIdentitySchema,
    inputSha256: workHashSchema,
    hostId: frameworkIdentitySchema,
    acceptedAt: z.string().datetime({offset: true}),
  })
  .strict()
/** The enrolled host registers an already accepted local job with its exact pins. */
export const routineWorkLocalRegistrationSchema = z.object({
  work: authoringWorkSchema,
  receipt: routineWorkAcceptanceSchema,
}).strict().superRefine((value, ctx) => {
  if (value.work.origin || value.work.workId !== value.receipt.workId || value.work.target.hostId !== value.receipt.hostId)
    ctx.addIssue({code: 'custom', message: 'Local registration requires its originless accepted host and work'})
})
const publicText = z.string().min(1).max(4000)
const githubPr = z.string().regex(/^https:\/\/github\.com\/Mentra-Community\/Mentra-Automated-Testing\/pull\/[1-9]\d*$/)
export const routineWorkProgressSchema = z
  .object({
    observedAt: z.string().datetime({offset: true}),
    completed: z.array(z.string().trim().min(1).max(500)).max(20),
    current: z.string().trim().min(1).max(2000),
    plan: z.array(z.string().trim().min(1).max(500)).max(20),
    estimatedCompletionAt: z.string().datetime({offset: true}).nullable(),
    estimateReason: z.string().trim().min(1).max(2000),
  })
  .strict()
const reviewUrl = z
  .string()
  .regex(
    /^https:\/\/github\.com\/Mentra-Community\/Mentra-Automated-Testing\/pull\/[1-9]\d*#pullrequestreview-[1-9]\d*$/,
  )
const sameReviewPr = (value: {prUrl: string; reviewUrl: string}) => value.reviewUrl.split('#')[0] === value.prUrl
export const routineWorkReviewSchema = z
  .object({
    prUrl: githubPr,
    reviewUrl,
    sourceRevision: sha,
    verdict: z.literal('APPROVED'),
  })
  .strict()
  .refine(sameReviewPr, 'Review belongs to another PR')
const resultUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value)
    return (
      ['https://admin.dev.mentraglass.com', 'https://admin.mentraglass.com'].includes(url.origin) &&
      !url.username &&
      !url.password &&
      !url.hash &&
      url.pathname === '/' &&
      [...url.searchParams.keys()].every((key) => key === 'testRun') &&
      frameworkIdentitySchema.safeParse(url.searchParams.get('testRun')).success
    )
  })
export const routineWorkCompletionSchema = z
  .object({
    sourceRevision: sha,
    prUrl: githubPr,
    reviewUrl,
    reviewedRevision: sha,
    resultUrl,
    summary: publicText,
  })
  .strict()
  .refine(
    (value) => value.sourceRevision === value.reviewedRevision && sameReviewPr(value),
    'Completion review differs from source',
  )
const jobDetails = z
  .object({
    questionId: frameworkIdentitySchema.optional(),
    question: publicText.optional(),
    summary: publicText.optional(),
    sourceRevision: sha.optional(),
    prUrl: githubPr.optional(),
    requestId: frameworkIdentitySchema.optional(),
    resultUrl: resultUrl.optional(),
    reason: publicText.optional(),
    progress: routineWorkProgressSchema.optional(),
    review: routineWorkReviewSchema.optional(),
    completion: routineWorkCompletionSchema.optional(),
  })
  .strict()
const jobEvent = z
  .object({
    eventId: frameworkIdentitySchema,
    sequence: z.number().int().positive().safe(),
    state: routineWorkStateSchema,
    at: z.string().datetime({offset: true}),
    details: jobDetails,
  })
  .strict()
export const authoringJobViewSchema = routineWorkAcceptanceSchema
  .extend({
    state: routineWorkStateSchema,
    sequence: z.number().int().nonnegative().safe(),
    work: authoringWorkSchema,
    attemptId: z.number().int().positive().safe().optional(),
    details: jobDetails,
    events: z.array(jobEvent).max(20),
  })
  .strict()
  .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 1024 * 1024, 'Job projection exceeds its byte limit')
export const routineWorkStatusSchema = z
  .object({
    workId: frameworkIdentitySchema,
    inputSha256: workHashSchema,
    hostId: frameworkIdentitySchema,
    eventId: frameworkIdentitySchema,
    sequence: z.number().int().positive().safe(),
    state: routineWorkStateSchema,
    details: authoringJobViewSchema,
  })
  .strict()
  .superRefine((event, ctx) => {
    const view = event.details
    if (
      event.workId !== view.workId ||
      event.inputSha256 !== view.inputSha256 ||
      event.hostId !== view.hostId ||
      event.sequence !== view.sequence ||
      event.state !== view.state ||
      view.work.workId !== view.workId ||
      view.work.target.hostId !== view.hostId ||
      new Set(view.events.map((value) => value.eventId)).size !== view.events.length ||
      view.events.some(
        (value, index) =>
          value.sequence > view.sequence || (index > 0 && value.sequence <= view.events[index - 1]!.sequence),
      )
    )
      ctx.addIssue({code: 'custom', message: 'Job projection differs from its status event'})
    const detail = view.details
    if (
      event.state === 'passed' &&
      (!view.attemptId ||
        !detail.review ||
        !detail.completion ||
        !detail.requestId ||
        detail.review.sourceRevision !== detail.completion.reviewedRevision ||
        detail.review.prUrl !== detail.completion.prUrl ||
        detail.review.reviewUrl !== detail.completion.reviewUrl ||
        detail.sourceRevision !== detail.completion.sourceRevision ||
        detail.prUrl !== detail.completion.prUrl ||
        detail.resultUrl !== detail.completion.resultUrl)
    )
      ctx.addIssue({code: 'custom', message: 'Passed work lacks its current attempt, exact formal review and recorded result links'})
    if (detail.review && detail.sourceRevision !== detail.review.sourceRevision)
      ctx.addIssue({code: 'custom', message: 'Current source differs from its approved review'})
    if (['failed', 'cancelled'].includes(event.state) && !detail.reason && !detail.summary)
      ctx.addIssue({code: 'custom', message: 'Terminal work requires its actual cause'})
  })
export type RoutineWorkStatus = z.infer<typeof routineWorkStatusSchema>
export type RoutineWorkProgress = z.infer<typeof routineWorkProgressSchema>
