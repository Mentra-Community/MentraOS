import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { createTestRunClaimApi } from "../api/internal/test-run-claims.api";
import { createTestRunIngestApi } from "../api/internal/test-runs.api";
import { adminAuth } from "../api/middleware/admin-auth.middleware";
import { TestRunClaimModel } from "../models/test-run-claim.model";
import type { TestRunClaimRequest, TestRunClaimResponse, TestRunClaimSettlement } from "../types/test-run-claim.types";
import {
  MongoTestRunClaimRepository, TestRunClaimService,
  type StoredTestRunClaim, type TestRunClaimRepository,
} from "./test-run-claim.service";

class MemoryRepository implements TestRunClaimRepository {
  claims = new Map<string, StoredTestRunClaim>();
  async get(id: string) { return structuredClone(this.claims.get(id) ?? null); }
  async insert(value: StoredTestRunClaim) {
    const current = this.claims.get(value.claim.requestId);
    if (current) return { stored: structuredClone(current), created: false };
    this.claims.set(value.claim.requestId, structuredClone(value));
    return { stored: structuredClone(value), created: true };
  }
  async settle(id: string, token: string, settlement: TestRunClaimSettlement, settledAt: string) {
    const current = this.claims.get(id)!;
    if (current.claim.state === "claimed" && current.executionTokenSha256 === token) {
      current.claim = { ...current.claim, state: settlement.state, settlement, settledAt };
    }
    return structuredClone(current);
  }
}
const TOKEN = "claim-capability-" + "a".repeat(32);
const INGEST_TOKEN = "ingest-capability-" + "b".repeat(32);
const fixture = (): TestRunClaimRequest => ({ requestId: "request-1", requestSha256: "a".repeat(64),
  workerId: "mini-1", fixtureId: "glasses-1", executionId: "execution-1", executionToken: "b".repeat(64) });
let repository: MemoryRepository;
let api: ReturnType<typeof createTestRunClaimApi>;
let oldClaimToken: string | undefined;
let oldIngestToken: string | undefined;
beforeEach(() => {
  oldClaimToken = process.env.TEST_RUN_CLAIM_TOKEN;
  oldIngestToken = process.env.TEST_RUN_INGEST_TOKEN;
  process.env.TEST_RUN_CLAIM_TOKEN = TOKEN;
  process.env.TEST_RUN_INGEST_TOKEN = INGEST_TOKEN;
  repository = new MemoryRepository();
  api = createTestRunClaimApi(new TestRunClaimService(repository));
});
afterEach(() => {
  if (oldClaimToken === undefined) delete process.env.TEST_RUN_CLAIM_TOKEN; else process.env.TEST_RUN_CLAIM_TOKEN = oldClaimToken;
  if (oldIngestToken === undefined) delete process.env.TEST_RUN_INGEST_TOKEN; else process.env.TEST_RUN_INGEST_TOKEN = oldIngestToken;
});
const send = (method: string, path: string, body?: unknown, token = TOKEN) => api.request(path, {
  method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const settle = (settlement: TestRunClaimSettlement, token = fixture().executionToken) =>
  send("PUT", "/request-1/state", { executionToken: token, settlement });
const body = async (response: Response) => await response.json() as TestRunClaimResponse;

describe("claim capability and execution ownership", () => {
  test("the internal route mount preserves the grant/status contract", async () => {
    const root = new Hono().route("/api/internal/test-run-claims", api);
    const response = await root.request("/api/internal/test-run-claims", {
      method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(fixture()),
    });
    expect(response.status).toBe(201);
    expect((await body(response)).executionGranted).toBe(true);
    expect((await root.request("/api/internal/test-run-claims/request-1")).status).toBe(401);
  });

  test("authenticates every endpoint before parsing and keeps ingest/admin capabilities separate", async () => {
    for (const [method, path] of [["POST", "/"], ["GET", "/request-1"], ["PUT", "/request-1/state"]]) {
      expect((await send(method!, path!, method === "GET" ? undefined : {}, "wrong")).status).toBe(401);
      expect((await send(method!, path!, method === "GET" ? undefined : {}, INGEST_TOKEN)).status).toBe(401);
    }
    expect((await api.request("/", { method: "POST", body: "invalid JSON" })).status).toBe(401);
    expect(repository.claims.size).toBe(0);
    for (const value of [undefined, "short"]) {
      if (value === undefined) delete process.env.TEST_RUN_CLAIM_TOKEN; else process.env.TEST_RUN_CLAIM_TOKEN = value;
      expect((await send("POST", "/", fixture())).status).toBe(503);
    }
    const ingestion = createTestRunIngestApi();
    expect((await ingestion.request("/", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "{}" })).status).toBe(401);
    const admin = new Hono(); admin.use("*", adminAuth); admin.get("/", c => c.text("admin"));
    expect((await admin.request("/", { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(401);
  });

  test("requires the owner execution token to settle and never discloses it", async () => {
    const created = await send("POST", "/", fixture());
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const first = await body(created);
    expect(first.executionGranted).toBe(true);
    expect(JSON.stringify(first)).not.toContain("executionToken");
    expect(JSON.stringify(await (await send("GET", "/request-1")).json())).not.toContain("executionToken");
    expect(repository.claims.get("request-1")!.executionTokenSha256).toBe(createHash("sha256").update(fixture().executionToken).digest("hex"));
    expect((await settle({ state: "terminal", resultRunId: "result-1" }, "c".repeat(64))).status).toBe(403);
    expect(repository.claims.get("request-1")!.claim.state).toBe("claimed");
  });
});

describe("single grant and monotonic settlement", () => {
  test("competing exact requests receive only one initial grant, including across service instances", async () => {
    const services = Array.from({ length: 20 }, () => new TestRunClaimService(repository));
    const results = await Promise.all(services.map(service => service.claim(fixture())));
    expect(results.filter(result => result.executionGranted)).toHaveLength(1);
    expect(new Set(results.map(result => result.claim.claimedAt)).size).toBe(1);
    expect((await send("POST", "/", fixture())).status).toBe(200);
    expect((await body(await send("GET", "/request-1"))).executionGranted).toBe(false);
    for (const patch of [{ requestSha256: "c".repeat(64) }, { workerId: "mini-2" }, { fixtureId: "glasses-2" },
      { executionId: "execution-2" }, { executionToken: "d".repeat(64) }]) {
      expect((await send("POST", "/", { ...fixture(), ...patch })).status).toBe(409);
    }
    expect(repository.claims.size).toBe(1);
  });

  test("only the first settlement wins and neither settlement nor replay grants another execution", async () => {
    await send("POST", "/", fixture());
    const terminal = { state: "terminal" as const, resultRunId: "result-1" };
    const recovery = { state: "recovery-required" as const, reason: "Interrupted transport" };
    const responses = await Promise.all([settle(terminal), settle(recovery)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const winner = await body(await send("GET", "/request-1"));
    const repeated = await body(await settle(winner.claim.settlement!));
    expect(repeated).toEqual(winner);
    expect(repeated.executionGranted).toBe(false);
    const duplicate = await send("POST", "/", fixture());
    expect(duplicate.status).toBe(200);
    expect((await body(duplicate)).executionGranted).toBe(false);
    expect((await send("PUT", "/request-1/state", { executionToken: fixture().executionToken, settlement: { state: "claimed" } })).status).toBe(400);
    expect((await send("DELETE", "/request-1")).status).toBe(404);
  });

  test("a write committed before its response failed stays reserved without a replay grant", async () => {
    const original = repository.insert.bind(repository);
    const uncertain = spyOn(repository, "insert").mockImplementation(async value => {
      await original(value);
      throw new Error("lost database acknowledgement");
    });
    const response = await send("POST", "/", fixture());
    expect(response.status).toBe(503);
    expect((await body(response)).executionGranted).toBe(false);
    uncertain.mockRestore();
    const replay = await send("POST", "/", fixture());
    expect(replay.status).toBe(200);
    expect((await body(replay)).executionGranted).toBe(false);
    expect((await settle({ state: "recovery-required", reason: "Claim response unknown; no hardware started" })).status).toBe(200);
    expect((await settle({ state: "terminal", resultRunId: "later-result" })).status).toBe(409);
  });

  test("an ambiguous settlement can be read/replayed without changing the original record", async () => {
    await send("POST", "/", fixture());
    const original = repository.settle.bind(repository);
    const uncertain = spyOn(repository, "settle").mockImplementation(async (...args) => {
      await original(...args); throw new Error("settlement response lost");
    });
    const value = { state: "terminal" as const, resultRunId: "result-1" };
    expect((await settle(value)).status).toBe(503);
    uncertain.mockRestore();
    const replay = await body(await settle(value));
    expect(replay).toEqual(await body(await send("GET", "/request-1")));
    expect(replay.executionGranted).toBe(false);
  });
});

test("rejects unbounded/malformed identities, extra control fields and missing claims", async () => {
  for (const patch of [{ requestId: "../escape" }, { requestSha256: "short" }, { executionToken: "short" },
    { workerId: "" }, { fixtureId: "../fixture" }, { executionId: "" }, { expiresAt: "tomorrow" }]) {
    expect((await send("POST", "/", { ...fixture(), ...patch })).status).toBe(400);
  }
  expect((await send("POST", "/", { ...fixture(), extra: "x".repeat(5000) })).status).toBe(413);
  expect((await send("GET", "/missing")).status).toBe(404);
  expect((await settle({ state: "terminal", resultRunId: "result-1" })).status).toBe(404);
  expect(repository.claims.size).toBe(0);
});

test("Mongo schema reserves request IDs uniquely without TTL or result-generation changes", () => {
  const indexes = TestRunClaimModel.schema.indexes();
  expect(indexes).toContainEqual([{ requestId: 1 }, { unique: true, background: true }]);
  expect(indexes.some(([, options]) => options.expireAfterSeconds !== undefined)).toBe(false);
});

test("Mongo insertion does not turn uncertain writes into grants and requires durable acknowledgement", async () => {
  const repository = new MongoTestRunClaimRepository();
  const get = spyOn(repository, "get").mockResolvedValue(null);
  const create = spyOn(TestRunClaimModel, "create").mockRejectedValue(new Error("write acknowledgement unknown"));
  try {
    await expect(new TestRunClaimService(repository).claim(fixture())).rejects.toThrow("write acknowledgement unknown");
    expect(get).not.toHaveBeenCalled();
    expect(create.mock.calls[0]![1]).toEqual({ writeConcern: { w: "majority", j: true, wtimeout: 10_000 } });
  } finally { get.mockRestore(); create.mockRestore(); }
});
