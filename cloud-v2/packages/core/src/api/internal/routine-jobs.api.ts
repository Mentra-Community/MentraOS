import {Hono, type Context} from 'hono';
import {z, ZodError} from 'zod';
import {RoutineJobService} from '../../services/routine-job.service';
import {RoutineWorkService} from '../../services/routine-work.service';
import {TestRunError} from '../../services/test-result-error';
import {TestDispatchError} from '../../services/test-builds.service';
import {TestRequestConflict} from '../../services/test-request.service';
import type {AppEnv} from '../../types/hono.types';
import {testRunIngestAuth} from '../middleware/test-run-ingest-auth.middleware';
import {createTestHostAuth, type TestHostEnv} from '../middleware/test-host-auth.middleware';
import {frameworkBodyLimit, frameworkJson} from './framework-json';
const failure = (error: Error, c: Context) => {
  if (error instanceof ZodError) return c.json({error: 'invalid_routine_job'}, 400);
  if (error instanceof TestRunError || error instanceof TestDispatchError)
    return c.json({error: 'routine_job_error', message: error.message}, error.status);
  if (error instanceof TestRequestConflict) return c.json({error: 'routine_job_conflict', message: error.message}, 409);
  c.var.logger?.error({errorName: error.name}, 'routine job operation failed');
  return c.json({error: 'routine_job_unavailable'}, 503);
};
/** Trusted device-free preparation and duplicate observer access; never a host credential. */
export function createRoutineJobsApi(service = new RoutineJobService(), authors = new RoutineWorkService()) {
  const fallback = async <T>(run: () => Promise<T>, author: () => Promise<unknown>) => {
    try {return await run();} catch (error) {if (!(error instanceof TestRunError) || error.status !== 404) throw error; return author();}
  };
  const app = new Hono<AppEnv>();
  app.use('*', testRunIngestAuth);
  app.use('*', async (c, next) => {c.header('Cache-Control', 'no-store'); await next();});
  app.onError(failure);
  app.post('/', frameworkBodyLimit(4096), async c => c.json(await service.submit(await frameworkJson(c)), 202));
  app.get('/:jobId/preparation', async c => c.json(await fallback(() => service.preparation(c.req.param('jobId')), () => authors.preparation(c.req.param('jobId')))));
  app.post('/:jobId/preparation', frameworkBodyLimit(), async c => {
    await service.prepared(c.req.param('jobId'), await frameworkJson(c));
    return c.json(await service.preparation(c.req.param('jobId')));
  });
  app.get('/:jobId/routine-source/inventory', async c => c.json(await service.inventory(c.req.param('jobId'))));
  app.get('/:jobId/routine-source/blobs/:sha', async c => {
    const bytes = await service.blob(c.req.param('jobId'), c.req.param('sha'));
    return new Response(bytes, {headers: {'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'}});
  });
  app.get('/:jobId/observation', async c => c.json(await fallback(() => service.observation(c.req.param('jobId')), () => authors.observation(c.req.param('jobId')))));
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
