/// <reference types="bun-types" />
import {afterEach, beforeEach, expect, test} from "bun:test"

import {createTransport} from "./auto"

/** Just enough WebSocket for the external-browser fallback: the test opens it by hand. */
class FakeWebSocket {
  static readonly OPEN = 1
  static created: FakeWebSocket[] = []

  readyState = 0
  closeCalls = 0
  onopen: (() => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onmessage: ((ev: {data: unknown}) => void) | null = null
  onclose: ((ev: {code: number; reason: string}) => void) | null = null

  constructor(readonly url: string) {
    FakeWebSocket.created.push(this)
  }

  send(): void {}

  close(): void {
    this.closeCalls += 1
  }

  connect(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }
}

const g = globalThis as unknown as {WebSocket: unknown}
let realWebSocket: unknown

beforeEach(() => {
  realWebSocket = g.WebSocket
  g.WebSocket = FakeWebSocket
  FakeWebSocket.created = []
})

afterEach(() => {
  g.WebSocket = realWebSocket
})

test("the external-browser fallback keeps its open socket when opened again", async () => {
  const transport = createTransport()
  const received: string[] = []
  transport.onMessage((raw) => received.push(raw))
  const opening = transport.open()
  FakeWebSocket.created[0]!.connect()
  await opening

  await transport.open()
  expect(FakeWebSocket.created).toHaveLength(1)
  expect(FakeWebSocket.created[0]!.closeCalls).toBe(0)
  FakeWebSocket.created[0]!.onmessage?.({data: "once"})
  expect(received).toEqual(["once"])
  transport.close()
})
