import {Hono, type Context} from 'hono';
import {z, ZodError} from 'zod';
import {RoutineJobService, RoutineLaneAcceptanceConflict, type RoutinePreparationPhase} from '../../services/routine-job.service';
import {RoutineWorkService} from '../../services/routine-work.service';
import {TestRunError} from '../../services/test-result-error';
import {TestDispatchError} from '../../services/test-builds.service';
import {TestRequestConflict} from '../../services/test-request.service';
import type {AppEnv} from '../../types/hono.types';
import {testRunIngestAuth} from '../middleware/test-run-ingest-auth.middleware';
import {createTestHostAuth, type TestHostEnv} from '../middleware/test-host-auth.middleware';
import {frameworkBodyLimit, frameworkJson} from './framework-json';
const failureDiagnostic = (error: unknown) => {
  if (error instanceof TestRunError) return {status: error.status, errorKind: 'routine_job_error'};
  if (error instanceof TestDispatchError) return {status: error.status, errorKind: 'routine_job_error'};
  if (error instanceof TestRequestConflict) return {status: 409, errorKind: 'routine_job_conflict'};
  if (error instanceof ZodError) return {status: 400, errorKind: 'invalid_routine_job'};
  return {status: 503, errorKind: 'routine_job_unavailable'};
};
const failure = (error: Error, c: Context) => {
  if (error instanceof ZodError) return c.json({error: 'invalid_routine_job'}, 400);
  if (error instanceof RoutineLaneAcceptanceConflict) {
    c.var.logger?.warn({jobId: c.req.param('jobId'), reqId: c.var.reqId, ...error.diagnostics}, 'routine job lane acceptance refused');
    return c.json({error: 'routine_job_conflict', message: error.message}, 409);
  }
  if (error instanceof TestRunError || error instanceof TestDispatchError)
    return c.json({error: 'routine_job_error', message: error.message}, error.status);
  if (error instanceof TestRequestConflict) return c.json({error: 'routine_job_conflict', message: error.message}, 409);
  c.var.logger?.error({errorName: error.name}, 'routine job operation failed');
  return c.json({error: 'routine_job_unavailable'}, 503);
};
/** Trusted device-free preparation and duplicate observer access; never a host credential. */
export function createRoutineJobsApi(service = new RoutineJobService(), authors = new RoutineWorkService()) {
  const preparation = async <T>(c: Context<AppEnv>, operation: 'lookup' | 'save', run: (onPhase: RoutinePreparationPhase) => Promise<T>) => {
    const startedAt = Date.now(); let phase = 'request', phaseStartedAt = startedAt, counts: Parameters<RoutinePreparationPhase>[1];
    const fields = () => ({operation, phase, jobId: c.req.param('jobId'), reqId: c.var.reqId, ...counts,
      stageElapsedMs: Math.max(0, Date.now() - phaseStartedAt), requestElapsedMs: Math.max(0, Date.now() - startedAt)});
    const timer = setTimeout(() => c.var.logger?.warn(fields(), 'routine job preparation is slow'), 10_000);
    const onPhase: RoutinePreparationPhase = (value, nextCounts) => {
      c.var.logger?.info(fields(), 'routine job preparation stage completed');
      phase = value; phaseStartedAt = Date.now(); counts = nextCounts;
    };
    try {
      const value = await run(onPhase);
      c.var.logger?.info(fields(), 'routine job preparation stage completed');
      if (operation === 'lookup') {
        const result = value as Partial<Awaited<ReturnType<RoutineJobService['preparation']>>> & {resourceTarget?: {hostId: string; laneId: string}};
        c.var.logger?.info({...fields(), state: result.state, waitingReason: result.waitingReason?.slice(0, 512) ?? null,
          resourceTarget: result.resourceTarget ?? null, routingLabelCount: result.routingLabels?.length ?? 0},
          'routine job preparation matching completed');
      }
      return value;
    } catch (error) {
      c.var.logger?.error({...fields(), errorName: error instanceof Error ? error.name : 'unknown'}, 'routine job preparation failed');
      throw error;
    } finally {clearTimeout(timer);}
  };
  const fallback = async <T>(run: () => Promise<T>, author: () => Promise<unknown>) => {
    try {return await run();} catch (error) {if (!(error instanceof TestRunError) || error.status !== 404) throw error; return author();}
  };
  const app = new Hono<AppEnv>();
  app.use('*', testRunIngestAuth);
  app.use('*', async (c, next) => {c.header('Cache-Control', 'no-store'); await next();});
  app.onError(failure);
  app.post('/', frameworkBodyLimit(4096), async c => c.json(await service.submit(await frameworkJson(c)), 202));
  app.get('/:jobId/preparation', async c => c.json(await preparation(c, 'lookup', onPhase => fallback(
    () => service.preparation(c.req.param('jobId'), onPhase),
    () => {onPhase('author-preparation'); return authors.preparation(c.req.param('jobId'));}))));
  app.post('/:jobId/preparation', frameworkBodyLimit(), async c => {
    const row = await preparation(c, 'save', async onPhase => service.prepared(c.req.param('jobId'), await frameworkJson(c), onPhase));
    return c.json({jobId: row.requestId, inputSha256: row.fleetInputSha256 ?? row.fleetSelectionSha256, state: row.state});
  });
  app.post('/:jobId/preparation-status', frameworkBodyLimit(4096), async c => c.json(await service.preparationStatus(c.req.param('jobId'), await frameworkJson(c))));
  app.get('/:jobId/routine-source/inventory', async c => c.json(await service.inventory(c.req.param('jobId'))));
  app.get('/:jobId/routine-source/blobs/:sha', async c => {
    const bytes = await service.blob(c.req.param('jobId'), c.req.param('sha'));
    return new Response(bytes, {headers: {'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'}});
  });
  app.get('/:jobId/observation', async c => {
    const startedAt = Date.now(); let phase = 'request';
    const diagnostic = () => ({phase, elapsedMs: Math.max(0, Date.now() - startedAt)});
    const timer = setTimeout(() => c.var.logger?.warn(diagnostic(), 'routine job observation is slow'), 10_000);
    try {
      const response = c.json(await fallback(() => service.observation(c.req.param('jobId'), value => {phase = value;}),
        () => {phase = 'author'; return authors.observation(c.req.param('jobId'));}));
      if (Date.now() - startedAt >= 10_000) c.var.logger?.warn({...diagnostic(), status: response.status}, 'slow routine job observation completed');
      return response;
    } catch (error) {
      if (Date.now() - startedAt >= 10_000) c.var.logger?.warn({...diagnostic(), ...failureDiagnostic(error), errorName: error instanceof Error ? error.name : 'unknown'}, 'slow routine job observation failed');
      throw error;
    } finally {clearTimeout(timer);}
  });
  app.post('/:jobId/actions', frameworkBodyLimit(4096), async c => {
    const input = await frameworkJson(c), jobId = c.req.param('jobId');
    return c.json(await fallback(() => service.actions(jobId, input), () => authors.actions(jobId, input)));
  });
  app.post('/:jobId/cancel', frameworkBodyLimit(4096), async c => {
    const body = z.object({reason: z.string().min(1).max(2000)}).strict().parse(await frameworkJson(c));
    return c.json(await fallback(() => service.cancel(c.req.param('jobId'), body), () => authors.cancel(c.req.param('jobId'), body)));
  });
  return app;
}
/** Mounted below test-requests so the already enrolled host token supplies hostId. */
export function createRoutineJobBindingApi(service = new RoutineJobService(), credentials?: () => string | undefined, authors = new RoutineWorkService()) {
  const app = new Hono<TestHostEnv>();
  app.use('*', createTestHostAuth(credentials));
  app.use('*', async (c, next) => {c.header('Cache-Control', 'no-store'); await next();});
  app.onError(failure);
  app.post('/:jobId/dispatch-completion', frameworkBodyLimit(4096), async c => {
    const input = await frameworkJson(c), jobId = c.req.param('jobId');
    try {return c.json({completion: await service.complete(jobId, c.var.testHostId, input)});}
    catch (error) {if (!(error instanceof TestRunError) || error.status !== 404) throw error;
      return c.json({completion: await authors.complete(jobId, c.var.testHostId, input)});}
  });
  app.post('/:jobId/bind', frameworkBodyLimit(4096), async c => {
    const input = await frameworkJson(c), jobId = c.req.param('jobId');
    try {return c.json(await service.bind(jobId, c.var.testHostId, input));}
    catch (error) {if (!(error instanceof TestRunError) || error.status !== 404) throw error;
      return c.json(await authors.bind(jobId, c.var.testHostId, input));}
  });
  return app;
}
