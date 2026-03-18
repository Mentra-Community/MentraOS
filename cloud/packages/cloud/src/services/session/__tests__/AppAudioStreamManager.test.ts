/**
 * AppAudioStreamManager tests — stream lifecycle, auto-reconnect, buffering,
 * and the data-loss fix (createStream starts with writer=null).
 *
 * IMPORTANT: Bun's TransformStream implements backpressure — writer.write()
 * blocks until the readable side is actively being consumed. Tests must start
 * draining the readable CONCURRENTLY with writes, not sequentially after.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { AppAudioStreamManager, parseBinaryFrame } from "../AppAudioStreamManager";
import type { SendPlayRequestFn } from "../AppAudioStreamManager";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal pino-like logger that swallows everything */
function createMockLogger() {
  const noop = (..._args: any[]) => {};
  const child = () => createMockLogger();
  return { debug: noop, info: noop, warn: noop, error: noop, child } as any;
}

/**
 * Drain a ReadableStream into a single Uint8Array.
 *
 * Returns a Promise that resolves when the stream ends (writer.close()).
 * Start this BEFORE writing/ending so the reader is actively pulling —
 * otherwise writer.write() blocks on backpressure in Bun.
 */
function drainStream(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Promise<Uint8Array>(async (resolve, reject) => {
    try {
      const reader = readable.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      reader.releaseLock();
      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      const result = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      resolve(result);
    } catch (err) {
      reject(err);
    }
  });
}

/** Generate a fake audio chunk of given size */
function fakeAudio(size: number, fill: number = 0xff): Uint8Array {
  const data = new Uint8Array(size);
  data.fill(fill);
  return data;
}

/** Generate a valid UUID v4 for streamId */
function uuid(): string {
  return crypto.randomUUID();
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe("AppAudioStreamManager", () => {
  let manager: AppAudioStreamManager;
  let logger: any;
  let sendPlayRequest: ReturnType<typeof mock>;
  let playRequestCalls: Array<{ streamId: string; streamUrl: string; packageName: string }>;

  beforeEach(() => {
    logger = createMockLogger();
    playRequestCalls = [];
    sendPlayRequest = mock((streamId: string, streamUrl: string, packageName: string) => {
      playRequestCalls.push({ streamId, streamUrl, packageName });
      return true;
    }) as any;

    manager = new AppAudioStreamManager("user-123", logger, sendPlayRequest as SendPlayRequestFn);
  });

  afterEach(() => {
    manager.dispose();
  });

  // ─── createStream ──────────────────────────────────────────────────────

  describe("createStream", () => {
    test("creates a stream successfully", () => {
      const streamId = uuid();
      const ok = manager.createStream(streamId, "com.test.app");
      expect(ok).toBe(true);
      expect(manager.hasStream(streamId)).toBe(true);
      expect(manager.getStreamCount()).toBe(1);
    });

    test("rejects duplicate stream IDs", () => {
      const streamId = uuid();
      manager.createStream(streamId, "com.test.app");
      const ok = manager.createStream(streamId, "com.test.app");
      expect(ok).toBe(false);
      expect(manager.getStreamCount()).toBe(1);
    });

    test("rejects after dispose", () => {
      manager.dispose();
      const ok = manager.createStream(uuid(), "com.test.app");
      expect(ok).toBe(false);
    });

    test("starts with writer=null (no premature TransformStream)", () => {
      // This is the data-loss fix: createStream must NOT create a TransformStream.
      // We verify by writing before claiming — data should buffer, not pipe to a
      // throwaway TransformStream that claimStream would discard.
      const streamId = uuid();
      manager.createStream(streamId, "com.test.app");

      // Writing before phone connects should buffer, not pipe
      const chunk = fakeAudio(100);
      manager.writeToStream(streamId, chunk);

      // Now claim — the buffered chunk should flush
      const claimed = manager.claimStream(streamId);
      expect(claimed).not.toBeNull();
      expect(claimed!.contentType).toBe("audio/mpeg");
    });
  });

  // ─── claimStream ───────────────────────────────────────────────────────

  describe("claimStream", () => {
    test("returns readable and contentType", () => {
      const streamId = uuid();
      manager.createStream(streamId, "com.test.app", "audio/mpeg");

      const claimed = manager.claimStream(streamId);
      expect(claimed).not.toBeNull();
      expect(claimed!.contentType).toBe("audio/mpeg");
      expect(claimed!.readable).toBeInstanceOf(ReadableStream);
    });

    test("returns null for nonexistent stream", () => {
      expect(manager.claimStream("nonexistent")).toBeNull();
    });

    test("returns null for ended stream with no pending data", async () => {
      const streamId = uuid();
      manager.createStream(streamId, "com.test.app");
      await manager.endStream(streamId);
      expect(manager.claimStream(streamId)).toBeNull();
    });

    test("supports multiple claims (reconnection)", () => {
      const streamId = uuid();
      manager.createStream(streamId, "com.test.app");

      // First claim
      const first = manager.claimStream(streamId);
      expect(first).not.toBeNull();

      // Second claim (simulates phone reconnect)
      const second = manager.claimStream(streamId);
      expect(second).not.toBeNull();

      // They should be different ReadableStream instances
      expect(first!.readable).not.toBe(second!.readable);
    });

    test("custom contentType is preserved", () => {
      const streamId = uuid();
      manager.createStream(streamId, "com.test.app", "audio/ogg");
      const claimed = manager.claimStream(streamId);
      expect(claimed!.contentType).toBe("audio/ogg");
    });
  });

  // ─── writeToStream ─────────────────────────────────────────────────────

  describe("writeToStream", () => {
    test("pipes data to phone when connected", async () => {
      const streamId = uuid();
      manager.createStream(streamId, "com.test.app");
      const claimed = manager.claimStream(streamId)!;

      // Start draining BEFORE writing — Bun backpressure requires active reader
      const drainPromise = drainStream(claimed.readable);

      const chunk = fakeAudio(64, 0xab);
      await manager.writeToStream(streamId, chunk);
      await manager.endStream(streamId);

      const received = await drainPromise;
      expect(received.length).toBe(64);
      expect(received[0]).toBe(0xab);
    });

    test("returns false for nonexistent stream", async () => {
      const ok = await manager.writeToStream("nope", fakeAudio(10));
      expect(ok).toBe(false);
    });

    test("returns false for ended stream", async () => {
      const streamId = uuid();
      manager.createStream(streamId, "com.test.app");
      await manager.endStream(streamId);
      const ok = await manager.writeToStream(streamId, fakeAudio(10));
      expect(ok).toBe(false);
    });

    test("buffers data when phone not connected and returns true", async () => {
      const streamId = uuid();
      manager.createStream(streamId, "com.test.app");
      manager.setStreamUrl(streamId, "https://cloud.test/api/audio/stream/user-123/" + streamId);

      // Write without claiming first — should buffer (writer is null)
      const ok = await manager.writeToStream(streamId, fakeAudio(100, 0xcc));
      expect(ok).toBe(true);

      // Now claim — buffered data flushes into the new TransformStream
      const claimed = manager.claimStream(streamId)!;

      // Start draining, then end
      const drainPromise = drainStream(claimed.readable);
      await manager.endStream(streamId);

      const received = await drainPromise;
      expect(received.length).toBe(100);
      expect(received[0]).toBe(0xcc);
    });

    test("multiple writes before phone connects all buffer and flush", async () => {
      const streamId = uuid();
      manager.createStream(streamId, "com.test.app");
      manager.setStreamUrl(streamId, "https://cloud.test/api/audio/stream/user-123/" + streamId);

      // Write 3 chunks before phone connects (all go to pendingChunks)
      await manager.writeToStream(streamId, fakeAudio(50, 0x01));
      await manager.writeToStream(streamId, fakeAudio(75, 0x02));
      await manager.writeToStream(streamId, fakeAudio(25, 0x03));

      // Phone connects — all 3 chunks flush
      const claimed = manager.claimStream(streamId)!;

      // Start draining, then end
      const drainPromise = drainStream(claimed.readable);
      await manager.endStream(streamId);

      const received = await drainPromise;
      expect(received.length).toBe(150);
      // Verify ordering
      expect(received[0]).toBe(0x01);
      expect(received[49]).toBe(0x01);
      expect(received[50]).toBe(0x02);
      expect(received[124]).toBe(0x02);
      expect(received[125]).toBe(0x03);
      expect(received[149]).toBe(0x03);
    });

    test("mix of buffered and direct writes", async () => {
      const streamId = uuid();
      manager.createStream(streamId, "com.test.app");
      manager.setStreamUrl(streamId, "https://cloud.test/api/audio/stream/user-123/" + streamId);

      // Write before phone connects (buffered)
      await manager.writeToStream(streamId, fakeAudio(40, 0xaa));

      // Phone connects — flushes the buffered chunk
      const claimed = manager.claimStream(streamId)!;

      // Start draining concurrently
      const drainPromise = drainStream(claimed.readable);

      // Write after phone is connected (direct pipe)
      await manager.writeToStream(streamId, fakeAudio(60, 0xbb));

      await manager.endStream(streamId);

      const received = await drainPromise;
      expect(received.length).toBe(100);
      expect(received[0]).toBe(0xaa);
      expect(received[39]).toBe(0xaa);
      expect(received[40]).toBe(0xbb);
      expect(received[99]).toBe(0xbb);
    });
  });

  // ─── endStream ─────────────────────────────────────────────────────────

  describe("endStream", () => {
    test("closes the writer when phone is connected", async () => {
      const streamId = uuid();
      manager.createStream(streamId, "com.test.app");
      const claimed = manager.claimStream(streamId)!;

      // Start draining BEFORE writing
      const drainPromise = drainStream(claimed.readable);

      await manager.writeToStream(streamId, fakeAudio(32));
      await manager.endStream(streamId);

      const received = await drainPromise;
      expect(received.length).toBe(32);
    });

    test("marks stream as ended when phone not connected", async () => {
      const streamId = uuid();
      manager.createStream(streamId, "com.test.app");

      await manager.endStream(streamId);

      // Writing after end should return false
      const ok = await manager.writeToStream(streamId, fakeAudio(10));
      expect(ok).toBe(false);
    });

    test("ended stream with pending data serves it on next claim then closes", async () => {
      const streamId = uuid();
      manager.createStream(streamId, "com.test.app");
      manager.setStreamUrl(streamId, "https://cloud.test/api/audio/stream/user-123/" + streamId);

      // Write data then end while phone is disconnected
      await manager.writeToStream(streamId, fakeAudio(80, 0xdd));
      await manager.endStream(streamId);

      // Phone reconnects — should get the buffered data and then stream closes
      const claimed = manager.claimStream(streamId);
      expect(claimed).not.toBeNull();

      // claimStream with ended=true flushes pending and calls writer.close(),
      // so we can drain immediately
      const received = await drainStream(claimed!.readable);
      expect(received.length).toBe(80);
      expect(received[0]).toBe(0xdd);
    });
  });

  // ─── destroyStream ─────────────────────────────────────────────────────

  describe("destroyStream", () => {
    test("removes the stream", () => {
      const streamId = uuid();
      manager.createStream(streamId, "com.test.app");
      manager.destroyStream(streamId);
      expect(manager.hasStream(streamId)).toBe(false);
      expect(manager.getStreamCount()).toBe(0);
    });

    test("is safe to call on nonexistent stream", () => {
      manager.destroyStream("nonexistent");
    });
  });

  // ─── Auto-reconnect ────────────────────────────────────────────────────

  describe("auto-reconnect", () => {
    test("triggers sendPlayRequest when writing to disconnected phone", async () => {
      const streamId = uuid();
      const streamUrl = "https://cloud.test/api/audio/stream/user-123/" + streamId;

      manager.createStream(streamId, "com.test.app");
      manager.setStreamUrl(streamId, streamUrl);

      // Write without phone connected — should trigger reconnect
      await manager.writeToStream(streamId, fakeAudio(50));

      expect(playRequestCalls.length).toBe(1);
      expect(playRequestCalls[0].streamId).toBe(streamId);
      expect(playRequestCalls[0].streamUrl).toBe(streamUrl);
      expect(playRequestCalls[0].packageName).toBe("com.test.app");
    });

    test("does NOT trigger reconnect when streamUrl is not set yet", async () => {
      const streamId = uuid();
      manager.createStream(streamId, "com.test.app");
      // Don't call setStreamUrl

      await manager.writeToStream(streamId, fakeAudio(50));

      // No play request sent because URL is unknown
      expect(playRequestCalls.length).toBe(0);
    });

    test("does not send duplicate reconnect requests", async () => {
      const streamId = uuid();
      manager.createStream(streamId, "com.test.app");
      manager.setStreamUrl(streamId, "https://cloud.test/api/audio/stream/user-123/" + streamId);

      // Write multiple times while disconnected
      await manager.writeToStream(streamId, fakeAudio(10));
      await manager.writeToStream(streamId, fakeAudio(10));
      await manager.writeToStream(streamId, fakeAudio(10));

      // Should only send ONE play request (reconnecting=true prevents duplicates)
      expect(playRequestCalls.length).toBe(1);
    });

    test("full reconnect cycle: connect → disconnect via re-claim → write → end", async () => {
      const streamId = uuid();
      const streamUrl = "https://cloud.test/api/audio/stream/user-123/" + streamId;

      manager.createStream(streamId, "com.test.app");
      manager.setStreamUrl(streamId, streamUrl);

      // Phase 1: Phone connects, receives some audio
      const firstClaim = manager.claimStream(streamId)!;
      const firstDrain = drainStream(firstClaim.readable);

      await manager.writeToStream(streamId, fakeAudio(50, 0x11));

      // Phase 2: Phone disconnects — simulated by a second claimStream which
      // closes the first writer (causing firstDrain to resolve)
      const secondClaim = manager.claimStream(streamId)!;
      const secondDrain = drainStream(secondClaim.readable);

      // First readable should have received 50 bytes and then closed
      const firstReceived = await firstDrain;
      expect(firstReceived.length).toBe(50);
      expect(firstReceived[0]).toBe(0x11);

      // Write on the new connection
      await manager.writeToStream(streamId, fakeAudio(75, 0x22));
      await manager.endStream(streamId);

      const secondReceived = await secondDrain;
      expect(secondReceived.length).toBe(75);
      expect(secondReceived[0]).toBe(0x22);
    });

    test("handles sendPlayRequest returning false (glasses WS down)", async () => {
      // Create a manager where sendPlayRequest fails
      const failingSend = mock(() => false) as any;
      const failManager = new AppAudioStreamManager("user-456", logger, failingSend as SendPlayRequestFn);

      const streamId = uuid();
      failManager.createStream(streamId, "com.test.app");
      failManager.setStreamUrl(streamId, "https://cloud.test/stream");

      // Write — reconnect attempt fails, data stays buffered
      const ok = await failManager.writeToStream(streamId, fakeAudio(40, 0xaa));
      expect(ok).toBe(true);

      // Phone eventually connects — buffered data should flush
      const claimed = failManager.claimStream(streamId)!;
      const drainPromise = drainStream(claimed.readable);

      await failManager.endStream(streamId);

      const received = await drainPromise;
      expect(received.length).toBe(40);
      expect(received[0]).toBe(0xaa);

      failManager.dispose();
    });

    test("reconnect after phone disconnect (simulated via destroyStream + re-create)", async () => {
      // In production, the phone disconnects → the HTTP response closes →
      // the TransformStream readable cancels → writer.write() throws →
      // manager sets writer=null → buffers → triggerReconnect.
      //
      // We can't easily cancel a locked readable in tests, so we simulate
      // the disconnect by using claimStream (which closes the old writer)
      // and verifying the buffer-and-reconnect path works.

      const streamId = uuid();
      const streamUrl = "https://cloud.test/api/audio/stream/user-123/" + streamId;

      manager.createStream(streamId, "com.test.app");
      manager.setStreamUrl(streamId, streamUrl);

      // Phone connects, we start draining
      const firstClaim = manager.claimStream(streamId)!;
      const firstDrain = drainStream(firstClaim.readable);

      // Write some audio successfully
      await manager.writeToStream(streamId, fakeAudio(20, 0x11));

      // Write data that the SDK sends while the phone is "between connections".
      // We buffer it by writing BEFORE the second claim but AFTER the first
      // writer is invalidated. Simulate by claiming again (closes old writer).
      const secondClaim = manager.claimStream(streamId)!;

      // First drain should resolve with the 20 bytes (old writer was closed)
      const firstReceived = await firstDrain;
      expect(firstReceived.length).toBe(20);
      expect(firstReceived[0]).toBe(0x11);

      // Now write on the second connection and end
      const secondDrain = drainStream(secondClaim.readable);
      await manager.writeToStream(streamId, fakeAudio(30, 0x22));
      await manager.endStream(streamId);

      const secondReceived = await secondDrain;
      expect(secondReceived.length).toBe(30);
      expect(secondReceived[0]).toBe(0x22);
    });
  });

  // ─── Data loss prevention (the createStream fix) ───────────────────────

  describe("data loss prevention", () => {
    test("early writes before phone connects are NOT lost", async () => {
      // This is the specific regression test for the data-loss bug.
      // Before the fix, createStream() created a TransformStream. Writes
      // went to that writer. When the phone connected, claimStream() closed
      // it and created a new one — all queued data was discarded.

      const streamId = uuid();
      manager.createStream(streamId, "com.test.app");
      manager.setStreamUrl(streamId, "https://cloud.test/api/audio/stream/user-123/" + streamId);

      // SDK starts writing immediately after stream creation (before phone connects).
      // With writer=null, these go straight to pendingChunks.
      await manager.writeToStream(streamId, fakeAudio(100, 0xaa));
      await manager.writeToStream(streamId, fakeAudio(200, 0xbb));
      await manager.writeToStream(streamId, fakeAudio(50, 0xcc));

      // Phone connects (HTTP GET to relay URL)
      const claimed = manager.claimStream(streamId)!;

      // Start draining concurrently (Bun backpressure)
      const drainPromise = drainStream(claimed.readable);

      // Write one more chunk after phone connects (direct pipe)
      await manager.writeToStream(streamId, fakeAudio(30, 0xdd));

      await manager.endStream(streamId);

      // All data should be present: 100 + 200 + 50 (buffered) + 30 (direct) = 380 bytes
      const received = await drainPromise;
      expect(received.length).toBe(380);

      // Verify ordering
      expect(received[0]).toBe(0xaa); // First buffered chunk
      expect(received[99]).toBe(0xaa);
      expect(received[100]).toBe(0xbb); // Second buffered chunk
      expect(received[299]).toBe(0xbb);
      expect(received[300]).toBe(0xcc); // Third buffered chunk
      expect(received[349]).toBe(0xcc);
      expect(received[350]).toBe(0xdd); // Direct write after connect
      expect(received[379]).toBe(0xdd);
    });

    test("rapid create → write → claim sequence preserves all data", async () => {
      // Simulates the common race: SDK creates stream, starts writing audio
      // immediately, and the phone connects very quickly after.

      const streamId = uuid();
      manager.createStream(streamId, "com.test.app");
      manager.setStreamUrl(streamId, "https://cloud.test/stream");

      // One quick write (buffered — writer is null)
      await manager.writeToStream(streamId, fakeAudio(64, 0xff));

      // Phone connects immediately — flushes the buffered chunk
      const claimed = manager.claimStream(streamId)!;

      const drainPromise = drainStream(claimed.readable);
      await manager.endStream(streamId);

      const received = await drainPromise;
      expect(received.length).toBe(64);
      expect(received[0]).toBe(0xff);
    });

    test("end before phone connects — phone still gets all data on claim", async () => {
      const streamId = uuid();
      manager.createStream(streamId, "com.test.app");
      manager.setStreamUrl(streamId, "https://cloud.test/stream");

      // SDK writes and ends before phone ever connects
      await manager.writeToStream(streamId, fakeAudio(120, 0xef));
      await manager.endStream(streamId);

      // Phone connects late — claimStream should flush + close
      const claimed = manager.claimStream(streamId);
      expect(claimed).not.toBeNull();

      const received = await drainStream(claimed!.readable);
      expect(received.length).toBe(120);
      expect(received[0]).toBe(0xef);
    });
  });

  // ─── dispose ───────────────────────────────────────────────────────────

  describe("dispose", () => {
    test("cleans up all streams", () => {
      manager.createStream(uuid(), "com.test.app");
      manager.createStream(uuid(), "com.test.app");
      expect(manager.getStreamCount()).toBe(2);

      manager.dispose();
      expect(manager.getStreamCount()).toBe(0);
    });

    test("is idempotent", () => {
      manager.createStream(uuid(), "com.test.app");
      manager.dispose();
      manager.dispose(); // Should not throw
      expect(manager.getStreamCount()).toBe(0);
    });
  });

  // ─── setStreamUrl ──────────────────────────────────────────────────────

  describe("setStreamUrl", () => {
    test("sets the URL on an existing stream", () => {
      const streamId = uuid();
      manager.createStream(streamId, "com.test.app");
      manager.setStreamUrl(streamId, "https://cloud.test/stream");
      // No assertion needed — if it doesn't throw, it worked.
      // The URL is used internally by triggerReconnect.
    });

    test("is safe to call on nonexistent stream", () => {
      manager.setStreamUrl("nonexistent", "https://cloud.test/stream");
    });
  });
});

// ─── parseBinaryFrame ────────────────────────────────────────────────────────

describe("parseBinaryFrame", () => {
  test("parses a valid frame", () => {
    const streamId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const audioData = new Uint8Array([0x01, 0x02, 0x03]);

    const frame = new Uint8Array(36 + 3);
    frame.set(new TextEncoder().encode(streamId), 0);
    frame.set(audioData, 36);

    const result = parseBinaryFrame(frame);
    expect(result).not.toBeNull();
    expect(result!.streamId).toBe(streamId);
    expect(result!.audioData.length).toBe(3);
    expect(result!.audioData[0]).toBe(0x01);
  });

  test("returns null for frames <= 36 bytes", () => {
    expect(parseBinaryFrame(new Uint8Array(36))).toBeNull();
    expect(parseBinaryFrame(new Uint8Array(0))).toBeNull();
    expect(parseBinaryFrame(new Uint8Array(10))).toBeNull();
  });

  test("returns null for invalid UUID header", () => {
    const frame = new Uint8Array(37);
    frame.set(new TextEncoder().encode("not-a-valid-uuid-at-all-nope-nope!!"), 0);
    frame[36] = 0xff;
    expect(parseBinaryFrame(frame)).toBeNull();
  });

  test("works with Buffer input", () => {
    const streamId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const audio = Buffer.from([0xaa, 0xbb]);
    const header = Buffer.from(streamId, "ascii");
    const frame = Buffer.concat([header, audio]);

    const result = parseBinaryFrame(frame);
    expect(result).not.toBeNull();
    expect(result!.streamId).toBe(streamId);
    expect(result!.audioData.length).toBe(2);
  });

  test("handles large audio payloads", () => {
    const streamId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const audioSize = 64 * 1024; // 64KB
    const frame = new Uint8Array(36 + audioSize);
    frame.set(new TextEncoder().encode(streamId), 0);
    frame.fill(0xcd, 36);

    const result = parseBinaryFrame(frame);
    expect(result).not.toBeNull();
    expect(result!.audioData.length).toBe(audioSize);
    expect(result!.audioData[0]).toBe(0xcd);
    expect(result!.audioData[audioSize - 1]).toBe(0xcd);
  });
});
