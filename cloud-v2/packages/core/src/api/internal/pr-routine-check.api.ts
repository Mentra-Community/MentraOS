import {createHash, createHmac, timingSafeEqual} from 'node:crypto'
import {Hono} from 'hono'
import {z} from 'zod'
import {appRepositorySchema} from '../../types/testing-source.types'
import {PrRoutineCheckService} from '../../services/pr-routine-check.service'
import {TestRunGithubApp} from '../../services/test-run-github-app'
import {ROUTINE_CHECK_REPOSITORY, ROUTINE_RERUN_ACTION} from '../../types/pr-routine-check.types'
import {frameworkBodyLimit} from './framework-json'
import {testRunIngestAuth} from '../middleware/test-run-ingest-auth.middleware'
import {isRoutineCheckLabel} from '../../types/pr-rerun-label.types'

const delivery = z.string().regex(/^[A-Za-z0-9-]{1,120}$/)
const webhook = z.object({repository: z.object({full_name: appRepositorySchema}),
  installation: z.object({id: z.number().int().positive()}), sender: z.object({login: z.string()}),
  action: z.string(), requested_action: z.object({identifier: z.string()}).optional(),
  pull_request: z.object({number: z.number().int().positive(), state: z.string(), head: z.object({sha: z.string().regex(/^[a-f0-9]{40}$/), ref: z.string(), repo: z.object({full_name: z.string()}).nullable()}), base: z.object({ref: z.string()}), labels: z.array(z.object({name: z.string()}))}).optional(),
  check_run: z.object({id: z.number().int().positive(), external_id: z.string(), head_sha: z.string().regex(/^[a-f0-9]{40}$/),
    app: z.object({id: z.number().int().positive()})}).optional()})
export function verifyRoutineWebhook(bytes: Uint8Array, signature: string | undefined, secret: string | undefined) {
  if (!secret || secret.length < 32 || !/^sha256=[a-f0-9]{64}$/.test(signature ?? '')) return false
  const expected = createHmac('sha256', secret).update(bytes).digest(), actual = Buffer.from(signature!.slice(7), 'hex')
  return timingSafeEqual(expected, actual)
}
/** Authenticated metadata only; this endpoint never loads PR application source. */
export function createPrRoutineCheckApi(service = new PrRoutineCheckService(), appIdentity = new TestRunGithubApp(),
  secret: () => string | undefined = () => process.env.TESTING_TEST_RUN_GITHUB_WEBHOOK_SECRET ?? process.env.TEST_RUN_GITHUB_WEBHOOK_SECRET) {
  const app = new Hono()
  app.use('*', frameworkBodyLimit(256 * 1024))
  app.onError((_, c) => c.json({error: 'routine_check_unavailable'}, 503))
  app.post('/webhook', async c => {
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    if (!verifyRoutineWebhook(bytes, c.req.header('x-hub-signature-256'), secret())) return c.json({error: 'invalid_signature'}, 401)
    const event = c.req.header('x-github-event'), deliveryId = delivery.safeParse(c.req.header('x-github-delivery'))
    let value: unknown
    try {value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes))} catch {return c.json({error: 'invalid_event'}, 400)}
    const parsed = webhook.safeParse(value)
    if (!parsed.success || !deliveryId.success || parsed.data.installation.id !== appIdentity.installationId)
      return c.json({error: 'invalid_event_identity'}, 400)
    const payload = parsed.data, digest = createHash('sha256').update(bytes).digest('hex')
    if (event === 'pull_request' && ['opened', 'reopened', 'synchronize', 'labeled', 'unlabeled', 'edited', 'closed'].includes(payload.action)) {
      if (!payload.pull_request) return c.json({error: 'invalid_pr_event'}, 400)
      const pr = payload.pull_request
      return c.json(await service.intake(pr.number, deliveryId.data, digest, {...(payload.repository.full_name === ROUTINE_CHECK_REPOSITORY ? {} : {repository: payload.repository.full_name}), number: pr.number, headSha: pr.head.sha,
        headRef: pr.head.ref, baseRef: pr.base.ref, sameRepository: pr.head.repo?.full_name === payload.repository.full_name,
        open: pr.state === 'open', labels: pr.labels.map(row => row.name).filter(isRoutineCheckLabel).sort(), peers: []}))
    }
    if (event === 'check_run' && (payload.action === 'rerequested' ||
        payload.action === 'requested_action' && payload.requested_action?.identifier === ROUTINE_RERUN_ACTION.identifier)) {
      const check = payload.check_run
      if (!check || check.app.id !== appIdentity.applicationId || !check.external_id) return c.json({error: 'invalid_check_control'}, 400)
      return c.json(await service.receiveControl({deliveryId: deliveryId.data, digest,
        gateId: check.external_id.split(':')[0]!, checkId: check.id, externalId: check.external_id,
        headSha: check.head_sha, repository: payload.repository.full_name, actor: payload.sender.login, kind: 'rerun'}))
    }
    return c.json({ignored: true})
  })
  app.use('/intake', testRunIngestAuth)
  app.post('/intake', async c => {
    const input = z.object({prNumber: z.number().int().positive(), deliveryId: delivery, repository: appRepositorySchema.optional()}).strict().safeParse(await c.req.json())
    if (!input.success) return c.json({error: 'invalid_pr_intake'}, 400)
    return c.json(await service.intake(input.data.prNumber, input.data.deliveryId,
      createHash('sha256').update(JSON.stringify(input.data)).digest('hex'), undefined, input.data.repository))
  })
  return app
}
