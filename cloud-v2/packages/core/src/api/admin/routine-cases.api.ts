import {Hono} from 'hono'
import {z} from 'zod'
import type {AppEnv} from '../../types/hono.types'
import {caseIdSchema, casePrSchema} from '../../types/routine-case.types'
import {frameworkIdentitySchema} from '../../types/framework-request.types'
import {TestSuiteService} from '../../services/test-suite.service'
import {rerunRootKey} from '../../services/test-rerun.service'
import {readCaseFollowUpSummaries} from '../../services/routine-case-projection.service'
import {RoutineFixProvenanceService} from '../../services/routine-fix-provenance.service'
import {RoutineCaseService} from '../../services/routine-case.service'
import {RoutineCaseOriginalService} from '../../services/routine-case-original.service'
import {TestRunError} from '../../services/test-result-error'
import {frameworkBodyLimit, frameworkJson} from '../internal/framework-json'

/** Existing authenticated Admin operator facade; agents retain their generation-fenced service contract. */
export function createRoutineCaseApi(originals = new RoutineCaseOriginalService(), service = new RoutineCaseService(undefined, undefined, originals),
  provenance = new RoutineFixProvenanceService(), suites = new TestSuiteService(), summaryReader = readCaseFollowUpSummaries) {
  const app = new Hono<AppEnv>()
  app.onError((error, c) => error instanceof TestRunError ? c.json({error: 'routine_case_error', message: error.message}, error.status)
    : error instanceof z.ZodError ? c.json({error: 'invalid_case_request'}, 400) : c.json({error: 'routine_case_unavailable'}, 503))
  const actor = (c: Parameters<typeof frameworkJson>[0]) => {
    const id = c.var.developer?.developerId
    if (!id) throw new TestRunError(403, 'Authenticated testing operator required')
    return {kind: 'operator' as const, id}
  }
  app.get('/suite/:suiteId', async c => {
    service.assertAvailable()
    const suite = await suites.summary(c.req.param('suiteId'))
    const roots = suite.members.map(member => ({memberId: member.memberId, key: rerunRootKey({suiteId: suite.suiteId}, member.memberId)}))
    const summaries = await summaryReader(roots.map(row => row.key))
    return c.json({members: roots.map(row => ({memberId: row.memberId, followUp: summaries.get(row.key) ?? null}))})
  })
  app.get('/original/:requestId', async c => {
    const occurrence = await originals.original(frameworkIdentitySchema.parse(c.req.param('requestId')))
    service.assertAvailable()
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
  app.get('/:id/occurrences/:occurrenceId/attempts', async c => {
    const detail = await service.detail(c.req.param('id'))
    const occurrence = detail.case.occurrences.find(row => row.occurrenceId === c.req.param('occurrenceId'))
    if (!occurrence) throw new TestRunError(404, 'Original occurrence does not belong to this case')
    return c.json(await provenance.history(occurrence, c.req.query('before') ? Number(c.req.query('before')) : undefined, detail.case.intendedFixes.map(pr=>({...pr,observation:detail.case.prObservations.find(value=>value.repository===pr.repository&&value.number===pr.number)??null}))))
  })
  app.get('/:id', async c => c.json(await service.detail(c.req.param('id'), c.req.query('before') ? Number(c.req.query('before')) : undefined,
    c.req.query('limit') ? Number(c.req.query('limit')) : undefined)))
  return app
}
