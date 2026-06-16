/// <reference types="bun-types" />

import {afterEach, beforeEach, describe, expect, test} from "bun:test"

import type {MiniappSession} from "../session"
import {UIModuleImpl, type RpcHandlerContext} from "./ui"

type InboundHandler = (data: unknown) => void

function mockSession(opts: {ready?: boolean} = {}) {
  let inboundHandler: InboundHandler | null = null
  const oneShotCalls: unknown[] = []
  const readyHandlers = new Set<() => void>()
  const session = {
    // Default to ready=true: the common case is the background session
    // has already connected by the time a WebView opens. Tests that
    // exercise the connect race pass ready:false and emitReady() later.
    ready: opts.ready ?? true,
    _subscribe(streamType: string, handler: (data: unknown) => void) {
      if (streamType === "_ui") inboundHandler = handler
      return () => {
        if (inboundHandler === handler) inboundHandler = null
      }
    },
    on(event: string, handler: () => void) {
      if (event === "ready") readyHandlers.add(handler)
      return () => readyHandlers.delete(handler)
    },
    sendOneShot(payload: object) {
      oneShotCalls.push(payload)
    },
  } as unknown as MiniappSession & {ready: boolean}
  return {
    session,
    deliver(env: unknown) {
      if (!inboundHandler) throw new Error("inboundHandler not bound")
      inboundHandler(env)
    },
    /** Flip the session to ready and fire its "ready" listeners. */
    emitReady() {
      ;(session as {ready: boolean}).ready = true
      for (const h of [...readyHandlers]) h()
    },
    oneShotCalls,
  }
}

describe("UIModuleImpl", () => {
  let mock: ReturnType<typeof mockSession>
  let ui: UIModuleImpl

  beforeEach(() => {
    mock = mockSession()
    ui = new UIModuleImpl(mock.session)
  })

  afterEach(() => {
    // nothing — Map clears on next construction
  })

  test("starts in closed state", () => {
    expect(ui.isOpen()).toBe(false)
  })

  test("methods are bind-safe — destructuring or passing as a callback works", () => {
    // Methods are arrow properties so `this` survives destructuring; a plain
    // method would throw `undefined is not an object (evaluating 'this.bound')`.
    const {send, on, onOpen, onClose, isOpen} = ui
    expect(() => isOpen()).not.toThrow()
    expect(() => onOpen(() => {})).not.toThrow()
    expect(() => onClose(() => {})).not.toThrow()
    expect(() => on("ch", () => {})).not.toThrow()
    // send returns early when !bound, but must not throw.
    expect(() => send("ch", {x: 1})).not.toThrow()
    // Once UI_OPEN lands, the destructured send should actually post.
    mock.deliver({type: "UI_OPEN"})
    send("ch", {x: 2})
    expect(mock.oneShotCalls).toHaveLength(1)
    expect((mock.oneShotCalls[0] as {channel: string}).channel).toBe("ch")
  })

  test("UI_OPEN flips isOpen to true and fires onOpen handlers", () => {
    const calls: number[] = []
    ui.onOpen(() => calls.push(1))
    ui.onOpen(() => calls.push(2))
    mock.deliver({type: "UI_OPEN"})
    expect(ui.isOpen()).toBe(true)
    expect(calls).toEqual([1, 2])
  })

  test("UI_CLOSE flips isOpen to false and fires onClose handlers", () => {
    const closes: number[] = []
    ui.onClose(() => closes.push(1))
    mock.deliver({type: "UI_OPEN"})
    mock.deliver({type: "UI_CLOSE"})
    expect(ui.isOpen()).toBe(false)
    expect(closes).toEqual([1])
  })

  test("onOpen registered AFTER UI_OPEN fires immediately for late subscribers", () => {
    mock.deliver({type: "UI_OPEN"})
    const calls: number[] = []
    ui.onOpen(() => calls.push(1))
    expect(calls).toEqual([1])
  })

  // Regression: the WebView's mentra.ready() (which produces UI_OPEN) races
  // the background session's CONNECT_ACK. If UI_OPEN wins, onOpen handlers
  // must NOT fire until the session is ready — otherwise they read null
  // capabilities and the UI renders a "no glasses" snapshot that never
  // self-corrects.
  test("UI_OPEN before session.ready defers onOpen until the ready event", () => {
    const m = mockSession({ready: false})
    const u = new UIModuleImpl(m.session)
    const calls: number[] = []
    u.onOpen(() => calls.push(1))

    m.deliver({type: "UI_OPEN"})
    // Bound immediately (send/isOpen work) but open handlers wait.
    expect(u.isOpen()).toBe(true)
    expect(calls).toEqual([])

    m.emitReady()
    expect(calls).toEqual([1])
  })

  test("onOpen registered while bound-but-not-ready also waits for ready", () => {
    const m = mockSession({ready: false})
    const u = new UIModuleImpl(m.session)
    m.deliver({type: "UI_OPEN"})
    const calls: number[] = []
    // Late subscriber arrives during the connect window — must not fire yet.
    u.onOpen(() => calls.push(1))
    expect(calls).toEqual([])

    m.emitReady()
    expect(calls).toEqual([1])
  })

  test("WebView closing during the connect window suppresses the deferred open", () => {
    const m = mockSession({ready: false})
    const u = new UIModuleImpl(m.session)
    const calls: number[] = []
    u.onOpen(() => calls.push(1))

    m.deliver({type: "UI_OPEN"})
    m.deliver({type: "UI_CLOSE"}) // user navigated away before connect landed
    m.emitReady()
    // No stale fire — a later UI_OPEN would re-trigger.
    expect(calls).toEqual([])
  })

  test("send() drops silently when no WebView is bound", () => {
    ui.send("state", {notes: []})
    expect(mock.oneShotCalls).toHaveLength(0)
  })

  test("send() emits UI_SEND envelope when bound", () => {
    mock.deliver({type: "UI_OPEN"})
    ui.send("state", {notes: ["a"]})
    expect(mock.oneShotCalls).toHaveLength(1)
    const sent = mock.oneShotCalls[0] as {type: string; channel: string; payload: unknown; seq: number}
    expect(sent.type).toBe("UI_SEND")
    expect(sent.channel).toBe("state")
    expect(sent.payload).toEqual({notes: ["a"]})
    expect(sent.seq).toBe(1)
  })

  test("seq counter monotonically increases per bind, resets on rebind", () => {
    mock.deliver({type: "UI_OPEN"})
    ui.send("a", 1)
    ui.send("a", 2)
    ui.send("a", 3)
    expect((mock.oneShotCalls as Array<{seq: number}>).map((c) => c.seq)).toEqual([1, 2, 3])
    mock.deliver({type: "UI_CLOSE"})
    mock.deliver({type: "UI_OPEN"})
    ui.send("a", 4)
    expect((mock.oneShotCalls[3] as {seq: number}).seq).toBe(1)
  })

  test("UI_MESSAGE fans out to channel subscribers", () => {
    const got: unknown[] = []
    ui.on("foo", (p) => got.push(p))
    mock.deliver({type: "UI_OPEN"})
    mock.deliver({type: "UI_MESSAGE", channel: "foo", payload: {x: 1}, seq: 1})
    expect(got).toEqual([{x: 1}])
  })

  test("UI_MESSAGE to unsubscribed channel is silently dropped", () => {
    mock.deliver({type: "UI_OPEN"})
    expect(() =>
      mock.deliver({type: "UI_MESSAGE", channel: "unknown", payload: {}, seq: 1}),
    ).not.toThrow()
  })

  test("unsubscribe removes the handler", () => {
    const got: unknown[] = []
    const off = ui.on("foo", (p) => got.push(p))
    mock.deliver({type: "UI_OPEN"})
    mock.deliver({type: "UI_MESSAGE", channel: "foo", payload: 1, seq: 1})
    off()
    mock.deliver({type: "UI_MESSAGE", channel: "foo", payload: 2, seq: 2})
    expect(got).toEqual([1])
  })

  test("handler throwing does not break fan-out to subsequent subscribers", () => {
    const got: number[] = []
    ui.on("foo", () => {
      throw new Error("boom")
    })
    ui.on("foo", () => got.push(2))
    mock.deliver({type: "UI_OPEN"})
    mock.deliver({type: "UI_MESSAGE", channel: "foo", payload: null, seq: 1})
    expect(got).toEqual([2])
  })

  test("onClose handler throwing does not stop subsequent close handlers", () => {
    const got: number[] = []
    ui.onClose(() => {
      throw new Error("boom")
    })
    ui.onClose(() => got.push(2))
    mock.deliver({type: "UI_OPEN"})
    mock.deliver({type: "UI_CLOSE"})
    expect(got).toEqual([2])
  })

  test("handle() registers a handler; UI_MESSAGE with requestId triggers reply", async () => {
    mock.deliver({type: "UI_OPEN"})
    ui.handle("rpc:add" as never, ((p: {a: number; b: number}) => p.a + p.b) as never)
    mock.deliver({type: "UI_MESSAGE", channel: "rpc:add", payload: {a: 2, b: 3}, seq: 1, requestId: "r1"})
    // Reply is dispatched async (handler may be Promise). Yield once.
    await new Promise((r) => setTimeout(r, 0))
    const reply = mock.oneShotCalls.find(
      (c) => (c as {requestId?: string}).requestId === "r1",
    ) as {type: string; channel: string; payload: unknown; requestId: string} | undefined
    expect(reply).toBeDefined()
    expect(reply!.type).toBe("UI_SEND")
    expect(reply!.channel).toBe("rpc:add")
    expect(reply!.payload).toEqual({ok: true, result: 5})
    expect(reply!.requestId).toBe("r1")
  })

  test("handle() — handler returning a Promise resolves asynchronously", async () => {
    mock.deliver({type: "UI_OPEN"})
    ui.handle("rpc:slow" as never, (async (p: number) => p * 2) as never)
    mock.deliver({type: "UI_MESSAGE", channel: "rpc:slow", payload: 7, seq: 1, requestId: "r-slow"})
    await new Promise((r) => setTimeout(r, 0))
    const reply = mock.oneShotCalls.find((c) => (c as {requestId?: string}).requestId === "r-slow") as
      | {payload: {ok: boolean; result?: unknown}}
      | undefined
    expect(reply?.payload).toEqual({ok: true, result: 14})
  })

  test("handle() — handler throwing sends an error reply", async () => {
    mock.deliver({type: "UI_OPEN"})
    ui.handle("rpc:fail" as never, (() => {
      throw new Error("nope")
    }) as never)
    mock.deliver({type: "UI_MESSAGE", channel: "rpc:fail", payload: null, seq: 1, requestId: "r-fail"})
    await new Promise((r) => setTimeout(r, 0))
    const reply = mock.oneShotCalls.find((c) => (c as {requestId?: string}).requestId === "r-fail") as
      | {payload: {ok: boolean; error?: {message: string}}}
      | undefined
    expect(reply?.payload.ok).toBe(false)
    expect(reply?.payload.error?.message).toBe("nope")
  })

  test("handle() — error.cause.code is forwarded to the wire payload", async () => {
    mock.deliver({type: "UI_OPEN"})
    ui.handle("rpc:coded" as never, (() => {
      throw Object.assign(new Error("bad input"), {cause: {code: "BAD_INPUT"}})
    }) as never)
    mock.deliver({type: "UI_MESSAGE", channel: "rpc:coded", payload: null, seq: 1, requestId: "r-coded"})
    await new Promise((r) => setTimeout(r, 0))
    const reply = mock.oneShotCalls.find((c) => (c as {requestId?: string}).requestId === "r-coded") as
      | {payload: {ok: boolean; error?: {message: string; code?: string}}}
      | undefined
    expect(reply?.payload.error).toEqual({message: "bad input", code: "BAD_INPUT"})
  })

  test("handle() — registering twice on the same channel throws", () => {
    ui.handle("rpc:dup" as never, (() => 1) as never)
    expect(() => ui.handle("rpc:dup" as never, (() => 2) as never)).toThrow(
      /already registered/,
    )
  })

  test("handle() — unhandle() removes the handler and allows re-register", () => {
    const off = ui.handle("rpc:reg" as never, (() => 1) as never)
    off()
    expect(() => ui.handle("rpc:reg" as never, (() => 2) as never)).not.toThrow()
  })

  test("UI_MESSAGE with requestId on an unregistered channel sends an error reply", async () => {
    mock.deliver({type: "UI_OPEN"})
    mock.deliver({
      type: "UI_MESSAGE",
      channel: "rpc:nobody",
      payload: null,
      seq: 1,
      requestId: "r-no",
    })
    await new Promise((r) => setTimeout(r, 0))
    const reply = mock.oneShotCalls.find((c) => (c as {requestId?: string}).requestId === "r-no") as
      | {payload: {ok: boolean; error?: {message: string}}}
      | undefined
    expect(reply?.payload.ok).toBe(false)
    expect(reply?.payload.error?.message).toMatch(/no handler/)
  })

  test("UI_CANCEL aborts the in-flight handler's signal and suppresses reply", async () => {
    mock.deliver({type: "UI_OPEN"})
    let resolve!: (v: number) => void
    const pending = new Promise<number>((r) => (resolve = r))
    let observedAbort = false
    ui.handle("rpc:wait" as never, ((async (_: unknown, ctx?: RpcHandlerContext) => {
      ctx?.signal.addEventListener("abort", () => {
        observedAbort = true
      })
      return await pending
    }) as never) as never)
    mock.deliver({type: "UI_MESSAGE", channel: "rpc:wait", payload: null, seq: 1, requestId: "r-w"})
    mock.deliver({type: "UI_CANCEL", requestId: "r-w"})
    resolve(42) // handler completes after cancel
    await new Promise((r) => setTimeout(r, 0))
    expect(observedAbort).toBe(true)
    // No reply for r-w should land — cancel suppressed it.
    const reply = mock.oneShotCalls.find((c) => (c as {requestId?: string}).requestId === "r-w")
    expect(reply).toBeUndefined()
  })
})
