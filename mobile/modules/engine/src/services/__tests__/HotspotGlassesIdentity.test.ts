/// <reference types="bun-types" />

import {describe, expect, mock, test} from "bun:test"

let answer: () => Promise<Response> = async () => new Response("{}")
const asked: string[] = []
const signals: (AbortSignal | undefined)[] = []
mock.module("../asg/localNetworkTransport", () => ({
  localNetworkTransport: {
    fetch: (url: string, init?: RequestInit) => {
      asked.push(url)
      signals.push(init?.signal ?? undefined)
      return answer()
    },
  },
}))
// The probe's deadline fires at once, so a probe that never answers is visible without waiting 5 s.
let fireDeadlines = false
mock.module("../../utils/timers", () => ({
  BgTimer: {
    setTimeout: (callback: () => void) => {
      if (fireDeadlines) queueMicrotask(callback)
      return 1
    },
    clearTimeout: () => {},
  },
}))

const {joinedGlassesIdentity} = await import("../HotspotGlassesIdentity")
const health = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), {status})

describe("who the glasses on the joined hotspot are", () => {
  test("asks the gateway's health endpoint and matches the Bluetooth serial", async () => {
    answer = health({status: "healthy", serial_number: " ML395472B "})
    expect(await joinedGlassesIdentity("192.168.43.1", "ML395472B")).toBe("same_glasses")
    expect(asked.at(-1)).toBe("http://192.168.43.1:8089/api/health")
  })

  test("names other glasses when the serials differ", async () => {
    answer = health({status: "healthy", serial_number: "ML394205B"})
    expect(await joinedGlassesIdentity("192.168.43.1", "ML395472B")).toBe("other_glasses")
  })

  test("keeps today's behavior when it cannot tell", async () => {
    answer = health({status: "healthy"})
    expect(await joinedGlassesIdentity("192.168.43.1", "ML395472B")).toBe("unknown")
    answer = health({serial_number: "ML394205B"}, 404)
    expect(await joinedGlassesIdentity("192.168.43.1", "ML395472B")).toBe("unknown")
    answer = async () => {
      throw new Error("timed out")
    }
    expect(await joinedGlassesIdentity("192.168.43.1", "ML395472B")).toBe("unknown")
    const before = asked.length
    expect(await joinedGlassesIdentity("192.168.43.1", null)).toBe("unknown")
    expect(asked.length).toBe(before)
  })

  test("gives up at the deadline when the glasses never answer, and aborts the request", async () => {
    fireDeadlines = true
    answer = () => new Promise<Response>(() => {})
    expect(await joinedGlassesIdentity("192.168.43.1", "ML395472B")).toBe("unknown")
    expect(signals.at(-1)?.aborted).toBe(true)
    const stuckBody = {ok: true, json: () => new Promise(() => {})} as unknown as Response
    answer = async () => stuckBody
    expect(await joinedGlassesIdentity("192.168.43.1", "ML395472B")).toBe("unknown")
    fireDeadlines = false
  })
})
