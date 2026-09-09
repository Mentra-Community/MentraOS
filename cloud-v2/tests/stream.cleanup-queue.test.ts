import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

const zadd = mock(async (..._args: unknown[]) => 1);
const zrem = mock(async (..._args: unknown[]) => 1);
const zrangebyscore = mock(async (..._args: unknown[]) => [] as string[]);
const pipelineZadd = mock((..._args: unknown[]) => pipeline);
const pipelineExec = mock(async () => []);
const pipeline = { zadd: pipelineZadd, exec: pipelineExec };
const redis = { zadd, zrem, zrangebyscore, pipeline: () => pipeline };

const provision = mock(async () => ({
  streamId: "input-1",
  ingest: { protocol: "rtmps" as const, url: "rtmps://example", streamKey: "key" },
  playback: { hls: "https://example/hls", dash: "https://example/dash" },
}));
const status = mock(async () => ({ streamId: "input-1", isConnected: false }));
const stop = mock(async () => ({ recordings: 0, input: "retained" as const }));
const reclaim = mock(async () => ({ recordings: 1, input: "deleted" as const }));
const discover = mock(async () => ({ inputs: [], truncated: false }));
const provider = { name: "test", provision, status, stop, reclaim, discover };

mock.module("../packages/runtime/src/clients/redis.client", () => ({ getRedis: () => redis }));
mock.module(
  "../packages/runtime/src/services/stream/providers/cloudflare-stream.provider",
  () => ({ createCloudflareStreamProvider: () => provider }),
);

let streamService: typeof import("../packages/runtime/src/services/stream/stream.service");

beforeAll(async () => {
  streamService = await import("../packages/runtime/src/services/stream/stream.service");
});

beforeEach(() => {
  for (const fn of [
    zadd,
    zrem,
    zrangebyscore,
    pipelineZadd,
    pipelineExec,
    provision,
    status,
    stop,
    reclaim,
    discover,
  ]) {
    fn.mockClear();
  }
  zrangebyscore.mockResolvedValue([]);
  stop.mockResolvedValue({ recordings: 0, input: "retained" });
  reclaim.mockResolvedValue({ recordings: 1, input: "deleted" });
  discover.mockResolvedValue({ inputs: [], truncated: false });
  streamService.resetStreamProvider();
});

afterEach(() => {
  streamService.stopStreamSweepLoop();
});

describe("managed stream cleanup queue", () => {
  test("provision registers every input before returning it", async () => {
    const before = Date.now();

    const result = await streamService.provisionStream("user-1", {});

    expect(result.streamId).toBe("input-1");
    expect(zadd).toHaveBeenCalledTimes(1);
    const [key, cleanupAt, member] = zadd.mock.calls[0]!;
    expect(key).toBe("managed-stream:cleanup");
    expect(cleanupAt as number).toBeGreaterThanOrEqual(before + 6 * 60 * 60 * 1000);
    expect(member).toBe("reclaim:input-1");
  });

  test("provision reclaims an input when it cannot register recovery", async () => {
    zadd.mockRejectedValueOnce(new Error("redis unavailable"));

    await expect(streamService.provisionStream("user-1", {})).rejects.toThrow(
      "redis unavailable",
    );

    expect(reclaim).toHaveBeenCalledWith("input-1");
  });

  test("an explicit stop pulls deferred cleanup forward", async () => {
    const before = Date.now();

    await streamService.stopStream("input-1");

    expect(zrem).not.toHaveBeenCalled();
    const [, retryAt, member] = zadd.mock.calls[0]!;
    expect(retryAt as number).toBeGreaterThanOrEqual(before + 60 * 1000);
    expect(member).toBe("stop:input-1");
  });

  test("successful status polling refreshes the inactivity deadline", async () => {
    const before = Date.now();

    await streamService.streamStatus("input-1");

    const [key, mode, cleanupAt, member] = zadd.mock.calls[0]!;
    expect(key).toBe("managed-stream:cleanup");
    expect(mode).toBe("XX");
    expect(cleanupAt as number).toBeGreaterThanOrEqual(before + 6 * 60 * 60 * 1000);
    expect(member).toBe("reclaim:input-1");
  });

  test("a late status refresh cannot overwrite an explicit-stop retry", async () => {
    await streamService.stopStream("input-1");
    await streamService.streamStatus("input-1");

    expect(zadd.mock.calls[0]?.[2]).toBe("stop:input-1");
    expect(zadd.mock.calls[1]).toEqual([
      "managed-stream:cleanup",
      "XX",
      expect.any(Number),
      "reclaim:input-1",
    ]);
  });

  test("completed explicit cleanup removes the queue entry", async () => {
    stop.mockResolvedValueOnce({ recordings: 1, input: "deleted" });

    await streamService.stopStream("input-1");

    expect(zrem).toHaveBeenCalledWith("managed-stream:cleanup", "reclaim:input-1", "stop:input-1");
  });

  test("a sweep reschedules due inputs before removing reclaimed entries", async () => {
    zrangebyscore.mockResolvedValue(["reclaim:input-1"]);

    const result = await streamService.sweepStreamsOnce();

    expect(zrangebyscore).toHaveBeenCalledTimes(1);
    expect(pipelineZadd).toHaveBeenCalledWith(
      "managed-stream:cleanup",
      expect.any(Number),
      "reclaim:input-1",
    );
    expect(reclaim).toHaveBeenCalledWith("input-1");
    expect(zrem).toHaveBeenCalledWith(
      "managed-stream:cleanup",
      "reclaim:input-1",
      "stop:input-1",
      "input-1",
    );
    expect(result).toEqual({ recordings: 1, inputs: 1 });
  });

  test("a stop retry preserves an empty input instead of reclaiming it early", async () => {
    zrangebyscore.mockResolvedValue(["stop:input-1"]);

    const result = await streamService.sweepStreamsOnce();

    expect(stop).toHaveBeenCalledWith("input-1");
    expect(reclaim).not.toHaveBeenCalled();
    expect(pipelineZadd).toHaveBeenCalledWith(
      "managed-stream:cleanup",
      expect.any(Number),
      "stop:input-1",
    );
    expect(zrem).not.toHaveBeenCalled();
    expect(result).toEqual({ recordings: 0, inputs: 0 });
  });

  test("legacy discovery seeds the queue without overwriting existing schedules", async () => {
    discover.mockResolvedValue({
      inputs: [{ streamId: "legacy", createdAt: 1_000 }],
      truncated: false,
    });

    await streamService.sweepStreamsOnce();

    expect(pipelineZadd).toHaveBeenCalledWith(
      "managed-stream:cleanup",
      "NX",
      1_000 + 6 * 60 * 60 * 1000,
      "reclaim:legacy",
    );
  });

  test("legacy discovery failure cannot block the authoritative queue", async () => {
    discover.mockRejectedValueOnce(new Error("list unavailable"));
    zrangebyscore.mockResolvedValue(["reclaim:input-1"]);

    const result = await streamService.sweepStreamsOnce();

    expect(reclaim).toHaveBeenCalledWith("input-1");
    expect(result).toEqual({ recordings: 1, inputs: 1 });
  });
});
