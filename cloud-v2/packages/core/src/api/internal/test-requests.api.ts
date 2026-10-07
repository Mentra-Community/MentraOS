import {TestRunError} from "../../services/test-result-error";
import {frameworkIdentitySchema} from "../../types/framework-request.types";
import {z} from "zod";
import {Hono} from "hono";
import {frameworkBodyLimit, frameworkJson} from "./framework-json";
import {hostCancellationSchema, hostRejectionSchema, TestRequestConflict, TestRequestService} from "../../services/test-request.service";
import {createTestHostAuth, type TestHostEnv} from "../middleware/test-host-auth.middleware";
import {RoutineDispatchService} from '../../services/routine-dispatch.service';
import {GithubRoutineSourceGateway} from '../../services/routine-source-selection.service';

const acceptanceSchema = z.object({requestId: frameworkIdentitySchema, hostId: frameworkIdentitySchema,
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/), acceptedAt: z.string().datetime({offset: true})}).strict();

/** Cloud delivery/acknowledgement only; host SQLite owns execution and allocation. */
export function createTestRequestsApi(service = new TestRequestService(), credentials?: () => string | undefined,
  sources = new GithubRoutineSourceGateway(), dispatch = new RoutineDispatchService(undefined, undefined, undefined, service)) {
  const app = new Hono<TestHostEnv>();
  app.use("*", createTestHostAuth(credentials));
  app.use("*", async (c, next) => {c.header("Cache-Control", "no-store"); await next();});
  app.onError((error, c) => {
    if (error instanceof z.ZodError) return c.json({error: 'invalid_request'}, 400);
    if (error instanceof TestRunError && error.status === 422) return c.json({error: 'routine_source_invalid', message: error.message}, 422);
    if (error instanceof TestRunError) return c.json({error: "invalid_request", message: error.message}, error.status);
    if (error instanceof TestRequestConflict) return c.json({error: "request_conflict", message: error.message}, 409);
    c.var.logger?.error({errorName: error.name}, "controller request delivery failed");
    return c.json({error: "request_delivery_unavailable"}, 503);
  });
  app.get("/", async c => c.json(await service.queued(c.var.testHostId,
    c.req.query("after"), Number(c.req.query("limit") ?? 50))));
  app.get("/cancellations", async c => c.json(await service.cancellations(c.var.testHostId,
    c.req.query("after"), Number(c.req.query("limit") ?? 50))));
  const active = async (requestId: string, hostId: string) => {
    const row = await service.preparation(requestId, hostId);
    if (row.state !== 'preparing') throw new TestRequestConflict('Routine request is no longer preparing');
    return row.dispatchIntent!;
  };
  app.get('/:requestId/preparation', async c => c.json({request: await service.preparation(c.req.param('requestId'), c.var.testHostId)}));
  app.get('/:requestId/routine-source/inventory', async c => {
    const intent = await active(c.req.param('requestId'), c.var.testHostId);
    return c.json(await sources.inventory(intent.routineRevision));
  });
  app.get('/:requestId/routine-source/blobs/:sha', async c => {
    const intent = await active(c.req.param('requestId'), c.var.testHostId);
    const inventory = await sources.inventory(intent.routineRevision), file = inventory.files.find(value => value.gitBlobSha1 === c.req.param('sha'));
    if (!file) throw new TestRequestConflict('Requested GitHub blob is not part of this exact routine inventory');
    const bytes = await sources.blob(file);
    await active(c.req.param('requestId'), c.var.testHostId);
    return new Response(bytes, {headers: {'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'}});
  });
  app.post('/:requestId/prepared', frameworkBodyLimit(), async c =>
    c.json({request: await dispatch.prepared(c.req.param('requestId'), c.var.testHostId, await frameworkJson(c))}));
  app.post('/:requestId/preparation-status', frameworkBodyLimit(4096), async c =>
    c.json({request: await service.preparationStatus(c.req.param('requestId'), c.var.testHostId, await frameworkJson(c))}));
  app.post('/:requestId/preparation-rejection', frameworkBodyLimit(4096), async c =>
    c.json({request: await service.rejectPreparation(c.req.param('requestId'), c.var.testHostId, await frameworkJson(c))}));
  app.post("/local", frameworkBodyLimit(), async c => {
    let body: unknown;
    body = await frameworkJson(c);
    const parsed = z.object({input: z.unknown(), receipt: acceptanceSchema}).strict().safeParse(body);
    if (!parsed.success) return c.json({error: "invalid_local_acceptance"}, 400);
    const row = await service.registerLocal(parsed.data.input, parsed.data.receipt, c.var.testHostId);
    return c.json({receipt: row.hostReceipt});
  });
  app.post("/:requestId/accept", frameworkBodyLimit(4096), async c => {
    let body: unknown;
    body = await frameworkJson(c);
    const parsed = acceptanceSchema.safeParse(body);
    if (!parsed.success || parsed.data.requestId !== c.req.param("requestId")) return c.json({error: "invalid_acceptance"}, 400);
    const row = await service.accept(parsed.data, c.var.testHostId);
    return c.json({receipt: row.hostReceipt});
  });
  app.post("/:requestId/reject", frameworkBodyLimit(4096), async c => {
    const parsed = hostRejectionSchema.safeParse(await frameworkJson(c));
    if (!parsed.success || parsed.data.requestId !== c.req.param("requestId")) return c.json({error: "invalid_rejection"}, 400);
    const row = await service.reject(parsed.data, c.var.testHostId);
    return c.json({rejection: row.hostRejection});
  });
  app.post("/:requestId/cancel-ack", frameworkBodyLimit(4096), async c => {
    const parsed = hostCancellationSchema.safeParse(await frameworkJson(c));
    if (!parsed.success || parsed.data.requestId !== c.req.param("requestId")) return c.json({error: "invalid_cancellation"}, 400);
    const row = await service.acknowledgeCancellation(parsed.data, c.var.testHostId);
    return c.json({cancellation: row.hostCancellation});
  });
  return app;
}
