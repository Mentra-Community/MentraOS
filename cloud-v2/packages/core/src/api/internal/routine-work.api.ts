import {Hono, type Context} from 'hono'
import {RoutineWorkService, type RoutineWorkDelivery} from '../../services/routine-work.service'
import {TestRunError} from '../../services/test-result-error'
import {TestDispatchError} from '../../services/test-builds.service'
import {TestRequestConflict} from '../../services/test-request.service'
import type {AppEnv} from '../../types/hono.types'
import {testRunIngestAuth} from '../middleware/test-run-ingest-auth.middleware'
import {createTestHostAuth, type TestHostEnv} from '../middleware/test-host-auth.middleware'
import {frameworkBodyLimit, frameworkJson} from './framework-json'

const failure = (error: Error, c: Context) => {
  if (error instanceof TestRunError || error instanceof TestDispatchError)
    return c.json({error: 'routine_work_error', message: error.message}, error.status)
  if (error instanceof TestRequestConflict) return c.json({error: 'routine_work_conflict', message: error.message}, 409)
  c.var.logger?.error({errorName: error.name}, 'authoring work delivery failed')
  return c.json({error: 'routine_work_unavailable'}, 503)
}
const projection = ({
  workId,
  requestSha256,
  inputSha256,
  hostId,
  request,
  work,
  createdAt,
  acceptance,
  status,
  reporting, fleetInputSha256, fleetDeadline, fleetBinding, fleetCancellation,
}: RoutineWorkDelivery) => ({
  workId,
  requestSha256,
  inputSha256,
  hostId,
  request,
  work,
  createdAt,
  acceptance,
  status, fleetInputSha256, fleetDeadline, fleetBinding, fleetCancellation,
  ...(reporting
    ? {
        reporting: {
          nextProgressAt: reporting.nextProgressAt,
          history: reporting.history,
          error: reporting.error,
          progressCommentId: reporting.progressCommentId,
          finalCommentId: reporting.finalCommentId,
        },
      }
    : {}),
})
export function createRoutineWorkIntakeApi(service = new RoutineWorkService()) {
  const app = new Hono<AppEnv>()
  app.use('*', testRunIngestAuth)
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    await next()
  })
  app.onError(failure)
  app.post('/', frameworkBodyLimit(256 * 1024), async (c) =>
    c.json(projection(await service.submit(await frameworkJson(c))), 202),
  )
  app.get('/:workId', async (c) => c.json(projection(await service.inspect(c.req.param('workId')))))
  app.post('/:workId/report', async (c) => {
    const row = await service.inspect(c.req.param('workId'))
    await service.report(row)
    return c.json({workId: row.workId, retained: true})
  })
  return app
}

/** Same authenticated host delivery boundary as routine replay; no device scheduling in Core. */
export function createRoutineWorkDeliveriesApi(
  service = new RoutineWorkService(),
  credentials?: () => string | undefined,
) {
  const app = new Hono<TestHostEnv>()
  app.use('*', createTestHostAuth(credentials))
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    await next()
  })
  app.onError(failure)
  app.get('/', async (c) =>
    c.json(await service.queued(c.var.testHostId, c.req.query('after'), Number(c.req.query('limit') ?? 10))),
  )
  app.post('/:workId/accept', frameworkBodyLimit(4096), async (c) => {
    const value = (await frameworkJson(c)) as {workId?: unknown}
    if (value?.workId !== c.req.param('workId')) return c.json({error: 'invalid_authoring_identity'}, 400)
    return c.json({receipt: await service.accept(value, c.var.testHostId)})
  })
  app.post('/:workId/status', frameworkBodyLimit(1024 * 1024 + 4096), async (c) => {
    const value = (await frameworkJson(c)) as {workId?: unknown}
    if (value?.workId !== c.req.param('workId')) return c.json({error: 'invalid_authoring_identity'}, 400)
    return c.json({receipt: await service.status(value, c.var.testHostId)})
  })
  return app
}
