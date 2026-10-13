import {Hono} from 'hono'
import {z} from 'zod'
import type {AppEnv} from '../../types/hono.types'
import {caseIdSchema, casePrSchema} from '../../types/routine-case.types'
import {frameworkIdentitySchema} from '../../types/framework-request.types'
import {RoutineCaseService} from '../../services/routine-case.service'
import {RoutineCaseOriginalService} from '../../services/routine-case-original.service'
import {TestRunError} from '../../services/test-result-error'
import {frameworkBodyLimit, frameworkJson} from '../internal/framework-json'

/** Existing authenticated Admin operator facade; agents retain their generation-fenced service contract. */
export function createRoutineCaseApi(originals = new RoutineCaseOriginalService(), service = new RoutineCaseService(undefined, undefined, originals)) {
  const app = new Hono<AppEnv>()
  app.onError((error, c) => error instanceof TestRunError ? c.json({error: 'routine_case_error', message: error.message}, error.status)
    : error instanceof z.ZodError ? c.json({error: 'invalid_case_request'}, 400) : c.json({error: 'routine_case_unavailable'}, 503))
  const actor = (c: Parameters<typeof frameworkJson>[0]) => {
    const id = c.var.developer?.developerId
    if (!id) throw new TestRunError(403, 'Authenticated testing operator required')
    return {kind: 'operator' as const, id}
  }
  app.get('/original/:requestId', async c => {
    service.assertAvailable()
    const occurrence = await originals.original(frameworkIdentitySchema.parse(c.req.param('requestId')))
    return c.json({followUps: await service.summaries([occurrence.rootKey])})
  })
  app.post('/', frameworkBodyLimit(8192), async c => {
    service.assertAvailable()
    const input = z.object({mutationId: z.string().uuid(), requestId: frameworkIdentitySchema,
      shared: z.object({caseId: caseIdSchema, revision: z.number().int().nonnegative(), explanation: z.string().trim().min(12).max(1000)}).strict().optional(),
      intendedFix: casePrSchema.optional()}).strict().parse(await frameworkJson(c))
    return c.json(await service.create(await originals.original(input.requestId), input.mutationId, actor(c), input.shared, input.intendedFix), 201)
  })
  app.post('/:id/reconcile-prs', frameworkBodyLimit(4096), async c => c.json(await service.reconcilePrs(c.req.param('id'), await frameworkJson(c), actor(c))))
  app.patch('/:id', frameworkBodyLimit(16384), async c => c.json(await service.update(c.req.param('id'), await frameworkJson(c), actor(c))))
  app.get('/:id', async c => c.json(await service.detail(c.req.param('id'), c.req.query('before') ? Number(c.req.query('before')) : undefined,
    c.req.query('limit') ? Number(c.req.query('limit')) : undefined)))
  return app
}
