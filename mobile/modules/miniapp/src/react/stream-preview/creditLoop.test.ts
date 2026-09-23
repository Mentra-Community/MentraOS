/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import {CreditLoop} from "./creditLoop"
import type {ParsedFrame} from "./protocol"
import {buildPreviewFrame} from "./testFrames"

/** Small frames: these tests are about the credit scheme, not about throughput. */
function frame(seq: number, gen = 3): ArrayBuffer {
  return buildPreviewFrame({width: 16, height: 16, sessionGen: gen, frameSeq: seq})
}

/**
 * The native sender releases the next frame only once the previous one is acked, so every test
 * delivers the way the transport does: one frame, then wait for this side to be done with it.
 */
async function deliver(loop: CreditLoop, buffers: ArrayBuffer[]): Promise<void> {
  for (const buffer of buffers) {
    loop.handleBinary(buffer)
    await loop.idle()
  }
}

describe("credit loop acking", () => {
  test("acks exactly once per frame, with the gen and seq from the header", async () => {
    const acks: Array<[number, number]> = []
    const loop = new CreditLoop({sendAck: (gen, seq) => acks.push([gen, seq])})
    await deliver(loop, [frame(1), frame(2), frame(3)])
    expect(acks).toEqual([
      [3, 1],
      [3, 2],
      [3, 3],
    ])
    const stats = loop.snapshot()
    expect(stats.framesReceived).toBe(3)
    expect(stats.acksSent).toBe(3)
    expect(stats.overlapped).toBe(0)
    expect(stats.parseErrors).toBe(0)
  })

  test("acks a generation change without reordering", async () => {
    const acks: Array<[number, number]> = []
    const loop = new CreditLoop({sendAck: (gen, seq) => acks.push([gen, seq])})
    await deliver(loop, [frame(9, 1), frame(1, 2)])
    expect(acks).toEqual([
      [1, 9],
      [2, 1],
    ])
  })

  test("acks after the draw is submitted", async () => {
    const order: string[] = []
    const drawn: ParsedFrame[] = []
    const loop = new CreditLoop({
      sendAck: () => order.push("ack"),
      draw: (parsed) => {
        order.push("draw")
        drawn.push(parsed)
        return 1.5
      },
    })
    await deliver(loop, [frame(1)])
    expect(order).toEqual(["draw", "ack"])
    expect(drawn).toHaveLength(1)
    expect(loop.snapshot().drawsSubmitted).toBe(1)
  })

  test("swapping the renderer keeps the credit state", async () => {
    const acks: number[] = []
    const draws: string[] = []
    const loop = new CreditLoop({sendAck: (_gen, seq) => acks.push(seq), draw: () => (draws.push("a"), 1)})
    await deliver(loop, [frame(1)])
    loop.setDraw(null)
    await deliver(loop, [frame(2)])
    loop.setDraw(() => (draws.push("b"), 1))
    await deliver(loop, [frame(3)])
    expect(acks).toEqual([1, 2, 3])
    expect(draws).toEqual(["a", "b"])
  })

  test("counts a frame that arrives while another is in flight instead of queueing it", async () => {
    const loop = new CreditLoop({sendAck: () => {}})
    loop.handleBinary(frame(1))
    loop.handleBinary(frame(2))
    expect(loop.inFlight).toBe(2)
    await loop.idle()
    expect(loop.snapshot().overlapped).toBe(1)
    expect(loop.snapshot().acksSent).toBe(2)
  })
})

describe("sender skips", () => {
  test("counts the frames missing from the sequence, not just the gaps", async () => {
    const loop = new CreditLoop({sendAck: () => {}})
    await deliver(loop, [frame(1), frame(2), frame(6), frame(7), frame(10)])
    const stats = loop.snapshot()
    expect(stats.skippedBySender).toBe(5)
    expect(stats.sequenceGaps).toBe(2)
  })

  test("a new generation restarts the sequence rather than reporting a huge gap", async () => {
    const loop = new CreditLoop({sendAck: () => {}})
    await deliver(loop, [frame(40, 1), frame(1, 2), frame(2, 2)])
    expect(loop.snapshot().skippedBySender).toBe(0)
    expect(loop.snapshot().sequenceGaps).toBe(0)
  })
})

describe("bad frames", () => {
  test("counts a parse error by reason, reports it, and never acks it", async () => {
    const acks: Array<[number, number]> = []
    const rejected: string[] = []
    const loop = new CreditLoop({
      sendAck: (gen, seq) => acks.push([gen, seq]),
      onParseError: (reason) => rejected.push(reason),
    })
    await deliver(loop, [
      buildPreviewFrame({width: 16, height: 16, corrupt: {magic: [0, 0, 0, 0]}}),
      frame(7),
      buildPreviewFrame({width: 16, height: 16, corrupt: {version: 4}}),
    ])
    expect(acks).toEqual([[3, 7]])
    expect(rejected).toEqual(["bad-magic", "unsupported-version"])
    const stats = loop.snapshot()
    expect(stats.framesReceived).toBe(3)
    expect(stats.acksSent).toBe(1)
    expect(stats.parseErrors).toBe(2)
    expect(stats.parseErrorsByReason).toEqual({"bad-magic": 1, "unsupported-version": 1})
    expect(stats.lastError).toContain("unsupported-version")
  })

  test("a renderer with no context is recorded and still acked", async () => {
    const acks: Array<[number, number]> = []
    const loop = new CreditLoop({sendAck: (gen, seq) => acks.push([gen, seq]), draw: () => null})
    await deliver(loop, [frame(1)])
    expect(acks).toEqual([[3, 1]])
    expect(loop.snapshot().drawsSubmitted).toBe(0)
    expect(loop.snapshot().lastError).toBe("draw_failed")
  })

  test("reset clears the counters", async () => {
    const acks: Array<[number, number]> = []
    const loop = new CreditLoop({sendAck: (gen, seq) => acks.push([gen, seq])})
    await deliver(loop, [frame(1)])
    loop.reset()
    expect(loop.snapshot()).toMatchObject({
      framesReceived: 0,
      acksSent: 0,
      parseErrors: 0,
      lastError: null,
      lastFrame: null,
    })
    await deliver(loop, [frame(2)])
    expect(acks).toEqual([
      [3, 1],
      [3, 2],
    ])
  })
})
