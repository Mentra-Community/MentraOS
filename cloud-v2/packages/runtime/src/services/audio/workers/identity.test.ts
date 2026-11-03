import { afterEach, describe, expect, test } from "bun:test";
import { resolveWorkerIdentity, type WorkerIdentity } from "./identity";
import { buildWorkerOptions } from "./pool";

describe("resolveWorkerIdentity", () => {
  test("workerData wins over env", () => {
    expect(
      resolveWorkerIdentity({ workerId: "w3", podId: "pod-a" }, { WORKER_ID: "x", POD_ID: "y" }),
    ).toEqual({ workerId: "w3", podId: "pod-a", consumerName: "pod-a:w3" });
  });

  test("falls back to env when workerData is absent (main thread)", () => {
    expect(resolveWorkerIdentity(null, { WORKER_ID: "w9", POD_ID: "pod-z" })).toEqual({
      workerId: "w9",
      podId: "pod-z",
      consumerName: "pod-z:w9",
    });
  });

  test("falls back to defaults, ignoring empty or non-string values", () => {
    expect(resolveWorkerIdentity({ workerId: "", podId: 5 }, {})).toEqual({
      workerId: "worker",
      podId: "pod",
      consumerName: "pod:worker",
    });
  });
});

describe("worker started with buildWorkerOptions", () => {
  const workers: Worker[] = [];
  const saved = { WORKER_ID: process.env.WORKER_ID, POD_ID: process.env.POD_ID };

  afterEach(() => {
    for (const w of workers.splice(0)) w.terminate();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function reportedIdentity(workerId: string, podId: string): Promise<WorkerIdentity> {
    const worker = new Worker(
      new URL("./identity.fixture.ts", import.meta.url),
      buildWorkerOptions(workerId, podId),
    );
    workers.push(worker);
    return new Promise((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<WorkerIdentity>) => resolve(e.data);
      worker.onerror = (e: ErrorEvent) => reject(new Error(e.message));
    });
  }

  test("reports its own worker and pod ids", async () => {
    expect(await reportedIdentity("w1", "pod-a")).toEqual({
      workerId: "w1",
      podId: "pod-a",
      consumerName: "pod-a:w1",
    });
  });

  test("distinct workers resolve distinct consumer names", async () => {
    const ids = await Promise.all([reportedIdentity("w0", "pod-a"), reportedIdentity("w1", "pod-a")]);
    expect(ids.map((i) => i.consumerName)).toEqual(["pod-a:w0", "pod-a:w1"]);
  });

  test("parent env already holding WORKER_ID / POD_ID does not override the pool's ids", async () => {
    process.env.WORKER_ID = "parent-worker";
    process.env.POD_ID = "parent-pod";
    expect(await reportedIdentity("w2", "pod-b")).toEqual({
      workerId: "w2",
      podId: "pod-b",
      consumerName: "pod-b:w2",
    });
  });
});
