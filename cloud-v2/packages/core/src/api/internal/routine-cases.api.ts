import {Hono} from 'hono'
import {z} from 'zod'
import {createTestHostAuth, type TestHostEnv} from '../middleware/test-host-auth.middleware'
import {frameworkBodyLimit, frameworkJson} from './framework-json'
import {RoutineCaseService} from '../../services/routine-case.service'
import {RoutineCaseOriginalService} from '../../services/routine-case-original.service'
import {caseClaimOperationSchema, caseClaimSchema} from '../../types/routine-case.types'
import {TestRunError} from '../../services/test-result-error'

/** Existing enrolled-host credentials identify the agent owner; bodies carry only its scoped case claim. */
export function createInternalRoutineCaseApi(service = new RoutineCaseService(undefined, undefined, new RoutineCaseOriginalService()),
  credentials?: () => string | undefined) {
  const app = new Hono<TestHostEnv>()
  app.use('*', createTestHostAuth(credentials))
  app.use('*', async (c, next) => {c.header('Cache-Control', 'no-store'); await next()})
  app.onError((error, c) => error instanceof TestRunError ? c.json({error: 'routine_case_error', message: error.message}, error.status)
    : error instanceof z.ZodError ? c.json({error: 'invalid_case_request'}, 400) : c.json({error: 'routine_case_unavailable'}, 503))
  app.post('/:id/claim', frameworkBodyLimit(4096), async c => c.json(await service.claim(c.req.param('id'),
    caseClaimOperationSchema.parse(await frameworkJson(c)), c.var.testHostId)))
  app.patch('/:id', frameworkBodyLimit(16384), async c => {
    const input = z.object({claim: z.object({token: z.string().regex(/^[A-Za-z0-9_-]{32,200}$/), generation: caseClaimSchema.shape.generation,
      branchKey: caseClaimSchema.shape.branchKey, anchorRunId: caseClaimSchema.shape.anchorRunId}).strict(), mutation: z.unknown()}).strict().parse(await frameworkJson(c))
    return c.json(await service.update(c.req.param('id'), input.mutation, {kind: 'agent', id: c.var.testHostId, ...input.claim}))
  })
  app.get('/:id', async c => c.json(await service.detail(c.req.param('id'))))
  return app
}
