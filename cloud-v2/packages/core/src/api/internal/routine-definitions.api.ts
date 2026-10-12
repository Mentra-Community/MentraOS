import {RoutineSourceBundleService, routineBundleMetadataSchema} from '../../services/routine-source-bundle.service';
import {ROUTINE_BUNDLE_BODY_BYTES} from '../../types/framework-version.types';
import {TestRunError} from "../../services/test-result-error";
import {Hono} from "hono";
import {frameworkBodyLimit, frameworkJson} from "./framework-json";
import {RoutineDefinitionConflict, RoutineDefinitionService} from "../../services/routine-definition.service";
import {createTestHostAuth, type TestHostEnv} from "../middleware/test-host-auth.middleware";
import {createHash, timingSafeEqual} from "node:crypto";
import {routineIdentitySchema, routinePlatformSchema} from '../../types/routine-definition.types';

/** Trusted controller source enrollment, separate from device result ingestion. */
export function createRoutineDefinitionsApi(service = new RoutineDefinitionService(), credentials?: () => string | undefined) {
  const app = new Hono<TestHostEnv>();
  const hostAuth = createTestHostAuth(credentials);
  app.use("*", async (c, next) => {
    // Offline preparation may publish/download bounded source bundles. It cannot enroll definitions or report host state.
    const expected = process.env.TEST_RUN_INGEST_TOKEN, supplied = /^Bearer (\S{1,4096})$/.exec(c.req.header('authorization') ?? '')?.[1];
    const hash = (value: string) => createHash('sha256').update(value).digest();
    if (/\/bundles\/[a-f0-9]{64}$/.test(c.req.path) && expected && expected.length >= 32 && supplied && timingSafeEqual(hash(supplied), hash(expected)))
      return next();
    return hostAuth(c, next);
  });
  app.onError((error, c) => {
    if (error instanceof TestRunError) return c.json({error: "invalid_definition", message: error.message}, error.status);
    if (error instanceof RoutineDefinitionConflict) return c.json({error: "definition_conflict", message: error.message}, 409);
    c.var.logger?.error({errorName: error.name}, "routine definition enrollment failed");
    return c.json({error: "definition_enrollment_unavailable"}, 503);
  });
  const bundles = new RoutineSourceBundleService();
  app.post('/bundles/:sha256', async c => {
    let metadata: unknown;
    try {metadata = routineBundleMetadataSchema.parse(JSON.parse(c.req.query('metadata') ?? ''));}
    catch {throw new TestRunError(400, 'Invalid routine bundle metadata');}
    const length = c.req.header('content-length');
    if (length && !c.req.header('transfer-encoding') && Number(length) > ROUTINE_BUNDLE_BODY_BYTES)
      throw new TestRunError(413, 'Routine bundle exceeds its bounded allowance');
    // ingress-nginx terminates TLS, overwrites x-forwarded-proto, and preserves Host,
    // matching account OAuth's publicOrigin derivation without trusting the pod's http URL.
    const url = new URL(c.req.url), proto = c.req.header('x-forwarded-proto') ?? url.protocol.replace(':', '');
    const origin = new URL(`${proto}://${url.host}`);
    if (origin.protocol !== 'https:' || origin.username || origin.password)
      throw new TestRunError(400, 'Routine bundle publication requires an HTTPS public origin');
    return c.json(await bundles.publish(c.req.param('sha256'), metadata, c.req.raw.body, origin.origin));
  });
  app.get('/bundles/:sha256', c => bundles.download(c.req.param('sha256')));
  app.post('/collection', frameworkBodyLimit(), async c => c.json(await service.publishCollection(await frameworkJson(c))));
  app.get('/:routineId', async c => {
    const id = routineIdentitySchema.safeParse(c.req.param('routineId'));
    const platform = routinePlatformSchema.safeParse(c.req.query('platform'));
    const revision = c.req.query('revision');
    if (!id.success || !platform.success || !revision || !/^[a-f0-9]{40}$/.test(revision))
      throw new TestRunError(400, 'Exact routine definition identity is required');
    const row = await service.getExact(id.data, platform.data, revision);
    if (!row) throw new TestRunError(404, 'Exact routine definition was not found');
    return c.json(row);
  });
  app.post("/", frameworkBodyLimit(), async c => {
    let input: unknown;
    input = await frameworkJson(c);
    const row = await service.enroll(input, c.var.testHostId);
    return c.json({routineId: row.routineId, platform: row.platform,
      definitionRevision: row.definitionRevision, definitionSha256: row.definitionSha256});
  });
  return app;
}
