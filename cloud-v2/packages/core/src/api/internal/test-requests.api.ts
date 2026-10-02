import {z} from "zod";
import {Hono} from "hono";
import {bodyLimit} from "hono/body-limit";
import {TestRequestConflict, TestRequestService, type HostAcceptance} from "../../services/test-request.service";
import {createTestHostAuth, type TestHostEnv} from "../middleware/test-host-auth.middleware";

const acceptanceSchema = z.object({requestId: z.string().min(1).max(240), hostId: z.string().min(1).max(240),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/), acceptedAt: z.string().datetime({offset: true})}).strict();

/** Cloud delivery/acknowledgement only; host SQLite owns execution and allocation. */
export function createTestRequestsApi(service = new TestRequestService(), credentials?: () => string | undefined) {
  const app = new Hono<TestHostEnv>();
  app.use("*", createTestHostAuth(credentials));
  app.use("*", async (c, next) => {c.header("Cache-Control", "no-store"); await next();});
  app.onError((error, c) => {
    if (error instanceof TestRequestConflict) return c.json({error: "request_conflict", message: error.message}, 409);
    c.var.logger?.error({errorName: error.name}, "controller request delivery failed");
    return c.json({error: "request_delivery_unavailable"}, 503);
  });
  app.get("/", async c => c.json(await service.queued(c.var.testHostId,
    c.req.query("after"), Number(c.req.query("limit") ?? 50))));
  app.post("/local", bodyLimit({maxSize: 1024 * 1024}), async c => {
    let body: unknown;
    try {body = await c.req.json();} catch {return c.json({error: "invalid_json"}, 400);}
    const parsed = z.object({input: z.unknown(), receipt: acceptanceSchema}).strict().safeParse(body);
    if (!parsed.success) return c.json({error: "invalid_local_acceptance"}, 400);
    const row = await service.registerLocal(parsed.data.input, parsed.data.receipt, c.var.testHostId);
    return c.json({receipt: row.hostReceipt});
  });
  app.post("/:requestId/accept", bodyLimit({maxSize: 4096}), async c => {
    let body: unknown;
    try {body = await c.req.json();} catch {return c.json({error: "invalid_json"}, 400);}
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({error: "invalid_acceptance"}, 400);
    const value = body as Record<string, unknown>;
    if (value.requestId !== c.req.param("requestId") || typeof value.hostId !== "string"
      || typeof value.acceptedAt !== "string" || typeof value.inputSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(value.inputSha256)) return c.json({error: "invalid_acceptance"}, 400);
    const row = await service.accept(value as unknown as HostAcceptance, c.var.testHostId);
    return c.json({receipt: row.hostReceipt});
  });
  return app;
}
