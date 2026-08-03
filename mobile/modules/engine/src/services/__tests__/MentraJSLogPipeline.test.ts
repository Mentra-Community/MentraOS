/// <reference types="bun-types" />

import {beforeEach, describe, expect, test} from "bun:test"

import {
  MentraJSLogRingBuffer,
  MentraJSLogThrottle,
  redactSecrets,
} from "../MentraJSLogPipeline"

describe("redactSecrets", () => {
  test("redacts strings containing 'token'", () => {
    expect(redactSecrets("token=abc123")).toBe("[REDACTED]")
    expect(redactSecrets("Bearer abc123")).toBe("[REDACTED]")
  })

  test("ordinary strings pass through unchanged", () => {
    expect(redactSecrets("hello world")).toBe("hello world")
    expect(redactSecrets("user@example.com")).toBe("user@example.com")
  })

  test("object keys matching a secret pattern get their value redacted", () => {
    expect(redactSecrets({apiKey: "abc", name: "alex"})).toEqual({
      apiKey: "[REDACTED]",
      name: "alex",
    })
  })

  test("api_key + bearer + password + auth + secret all match", () => {
    expect(
      redactSecrets({
        api_key: "1",
        bearer: "2",
        password: "3",
        auth: "4",
        secret: "5",
        ok: "6",
      }),
    ).toEqual({
      api_key: "[REDACTED]",
      bearer: "[REDACTED]",
      password: "[REDACTED]",
      auth: "[REDACTED]",
      secret: "[REDACTED]",
      ok: "6",
    })
  })

  test("nested objects are walked recursively", () => {
    expect(redactSecrets({user: {name: "alex", token: "x"}})).toEqual({
      user: {name: "alex", token: "[REDACTED]"},
    })
  })

  test("arrays are walked element-by-element", () => {
    expect(redactSecrets(["hello", "Bearer x", {token: "y"}])).toEqual([
      "hello",
      "[REDACTED]",
      {token: "[REDACTED]"},
    ])
  })

  test("primitives other than strings pass through", () => {
    expect(redactSecrets(42)).toBe(42)
    expect(redactSecrets(true)).toBe(true)
    expect(redactSecrets(null)).toBe(null)
    expect(redactSecrets(undefined)).toBe(undefined)
  })

  test("returns a new object (does not mutate the input)", () => {
    const input = {token: "x", name: "alex"}
    redactSecrets(input)
    expect(input.token).toBe("x") // not mutated
  })
})

describe("MentraJSLogThrottle", () => {
  let clock: number
  let throttle: MentraJSLogThrottle

  beforeEach(() => {
    clock = 1_000_000
    throttle = new MentraJSLogThrottle({
      tokensPerSecond: 10, // higher rate for cleaner test arithmetic
      bucketCapacity: 5,
      now: () => clock,
    })
  })

  function advance(ms: number) {
    clock += ms
  }

  test("first N calls are allowed up to bucketCapacity", () => {
    for (let i = 0; i < 5; i++) {
      expect(throttle.consume("a")).toEqual({allowed: true})
    }
  })

  test("over-cap calls are dropped silently after the burst", () => {
    for (let i = 0; i < 5; i++) {
      throttle.consume("a")
    }
    expect(throttle.consume("a")).toEqual({allowed: false})
    expect(throttle.consume("a")).toEqual({allowed: false})
  })

  test("first allow after a drop reports the cumulative throttled count", () => {
    for (let i = 0; i < 5; i++) {
      throttle.consume("a")
    }
    throttle.consume("a") // drop
    throttle.consume("a") // drop
    throttle.consume("a") // drop — 3 total dropped
    advance(1_000) // refill ~10 tokens
    const next = throttle.consume("a")
    expect(next).toEqual({allowed: false, throttledLine: "[throttled 3]"})
  })

  test("each package has its own bucket", () => {
    for (let i = 0; i < 5; i++) {
      throttle.consume("a")
    }
    expect(throttle.consume("a")).toEqual({allowed: false})
    expect(throttle.consume("b")).toEqual({allowed: true})
  })

  test("bucket refills based on elapsed time", () => {
    for (let i = 0; i < 5; i++) {
      throttle.consume("a")
    }
    advance(500) // 5 tokens at 10/sec, no drops yet
    // First refilled call is plain `{allowed: true}` — no prior drops to summarise.
    expect(throttle.consume("a")).toEqual({allowed: true})
  })

  test("synthetic [throttled N] line is emitted on the first allow after drops", () => {
    for (let i = 0; i < 5; i++) {
      throttle.consume("a")
    }
    throttle.consume("a") // drop 1
    throttle.consume("a") // drop 2
    advance(500)
    // The next would-be-allowed call gets converted into the throttled
    // summary. Caller drops the original line and emits the synthetic one.
    const next = throttle.consume("a")
    expect(next).toEqual({allowed: false, throttledLine: "[throttled 2]"})
    // Subsequent calls return plain {allowed:true}.
    expect(throttle.consume("a")).toEqual({allowed: true})
  })
})

describe("MentraJSLogRingBuffer", () => {
  test("retains the last N lines per package", () => {
    const buf = new MentraJSLogRingBuffer(3)
    buf.push("a", "1")
    buf.push("a", "2")
    buf.push("a", "3")
    buf.push("a", "4")
    expect(buf.snapshot("a")).toEqual(["2", "3", "4"])
  })

  test("isolates per-package state", () => {
    const buf = new MentraJSLogRingBuffer(3)
    buf.push("a", "a1")
    buf.push("b", "b1")
    expect(buf.snapshot("a")).toEqual(["a1"])
    expect(buf.snapshot("b")).toEqual(["b1"])
  })

  test("clear drops the buffer", () => {
    const buf = new MentraJSLogRingBuffer(3)
    buf.push("a", "1")
    buf.clear("a")
    expect(buf.snapshot("a")).toEqual([])
  })

  test("snapshot returns a copy, not the internal buffer", () => {
    const buf = new MentraJSLogRingBuffer(3)
    buf.push("a", "1")
    const snap = buf.snapshot("a")
    snap.push("oops")
    expect(buf.snapshot("a")).toEqual(["1"])
  })
})
