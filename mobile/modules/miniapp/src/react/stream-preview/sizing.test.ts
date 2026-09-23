/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import {ResizeCoalescer, type PreviewBox} from "./resizeCoalescer"
import {PREVIEW_TIERS, quantizePreviewTier} from "./tiers"

describe("tier quantization", () => {
  test("picks the smallest tier that covers the box, capped at the ceiling", () => {
    expect(quantizePreviewTier(200, 100)).toEqual({width: 320, height: 180, maxFps: 15})
    expect(quantizePreviewTier(320, 180)).toEqual({width: 320, height: 180, maxFps: 15})
    expect(quantizePreviewTier(321, 180)).toEqual({width: 640, height: 360, maxFps: 15})
    expect(quantizePreviewTier(2400, 1350)).toEqual(PREVIEW_TIERS.at(-1)!)
    // A portrait box taller than every tier still gets the ceiling; native fits inside it.
    expect(quantizePreviewTier(300, 900)).toEqual({width: 640, height: 360, maxFps: 15})
  })

  test("a zero-size box is hidden", () => {
    expect(quantizePreviewTier(0, 0)).toBeNull()
    expect(quantizePreviewTier(640, 0)).toBeNull()
    expect(quantizePreviewTier(Number.NaN, 100)).toBeNull()
  })

  test("the frame rate never rises with the box", () => {
    expect(new Set(PREVIEW_TIERS.map((tier) => tier.maxFps))).toEqual(new Set([15]))
  })
})

function harness() {
  const frames: Array<() => void> = []
  const timers = new Map<number, () => void>()
  let nextTimer = 1
  const applied: PreviewBox[] = []
  const coalescer = new ResizeCoalescer({
    apply: (box) => applied.push(box),
    requestFrame: (cb) => frames.push(cb),
    setTimer: (cb) => {
      const id = nextTimer++
      timers.set(id, cb)
      return id
    },
    clearTimer: (id) => timers.delete(id as number),
  })
  return {
    coalescer,
    applied,
    flushFrames: () => frames.splice(0).forEach((cb) => cb()),
    fireTimers: () => {
      const pending = [...timers.values()]
      timers.clear()
      pending.forEach((cb) => cb())
    },
    pendingTimers: () => timers.size,
  }
}

describe("resize coalescing", () => {
  test("the first measurement applies immediately", () => {
    const h = harness()
    h.coalescer.push({width: 600, height: 340})
    expect(h.applied).toEqual([{width: 600, height: 340}])
  })

  test("a storm inside one frame and the settle window collapses to one apply", () => {
    const h = harness()
    h.coalescer.push({width: 300, height: 170})
    for (let width = 301; width < 360; width += 1) h.coalescer.push({width, height: 200})
    expect(h.applied).toHaveLength(1)
    h.flushFrames()
    // More movement during the settle window restarts it.
    h.coalescer.push({width: 400, height: 225})
    h.flushFrames()
    expect(h.pendingTimers()).toBe(1)
    h.fireTimers()
    expect(h.applied).toEqual([
      {width: 300, height: 170},
      {width: 400, height: 225},
    ])
  })

  test("hiding and re-showing apply at once", () => {
    const h = harness()
    h.coalescer.push({width: 600, height: 340})
    h.coalescer.push({width: 0, height: 0})
    h.coalescer.push({width: 600, height: 340})
    expect(h.applied).toEqual([
      {width: 600, height: 340},
      {width: 0, height: 0},
      {width: 600, height: 340},
    ])
  })

  test("nothing applies after cancel", () => {
    const h = harness()
    h.coalescer.push({width: 600, height: 340})
    h.coalescer.push({width: 500, height: 300})
    h.coalescer.cancel()
    h.flushFrames()
    h.fireTimers()
    expect(h.applied).toHaveLength(1)
  })
})
