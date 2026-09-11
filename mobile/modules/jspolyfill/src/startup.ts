/**
 * MentraJS polyfill bundle entry point.
 *
 * This file gets compiled (via scripts/build.mjs) into a single IIFE that
 * is `evaluateScript`-ed inside every per-miniapp JSContext at spawn
 * time, BEFORE the miniapp's own `background/index.js`. By the time the
 * miniapp runs, `globalThis` looks like a Web Worker — console, fetch,
 * WebSocket, setTimeout, localStorage, crypto, all installed.
 *
 * Native (Swift on iOS, Kotlin on Android) has already injected the
 * following before this file runs:
 *   - __dispatch(iface, method, argsJson) — synchronous on iOS,
 *     suspending under the hood on Android. Always JSON-only across the
 *     bridge to keep the surface platform-symmetric.
 *   - __hostLog(level, messageJson) — console.* sink.
 *   - __hostError(payloadJson) — window.onerror sink.
 *   - __hostUnhandledRejection(payloadJson) — Promise rejection sink.
 *   - __nativeSetTimeout(callbackToken, delayMs) — schedules a fire-once
 *     timer; native calls __deliverTimer(token) when it elapses.
 *   - __nativeClearTimer(token) — cancels.
 *
 * On Android Zipline pre-injects `console.{log,info,warn,error}` and
 * `setTimeout` / `clearTimeout`. We guard those installs with
 * `if (!globalThis.X)` so we don't clobber the pre-injected versions.
 *
 * NO imports from other files in this package — the bundler inlines
 * what's needed. This file is the only entry; types live in types.ts
 * but are stripped at build time.
 */

declare const __dispatch: (iface: string, method: string, argsJson: string) => string | null
declare const __hostLog: (level: string, messageJson: string) => void
declare const __hostError: (payloadJson: string) => void
declare const __hostUnhandledRejection: (payloadJson: string) => void
declare const __nativeSetTimeout: (token: number, delayMs: number) => void
declare const __nativeClearTimer: (token: number) => void

;(function installMentraJSRuntime(): void {
  const g = globalThis as Record<string, unknown> & {
    console?: Console
    setTimeout?: typeof setTimeout
    clearTimeout?: typeof clearTimeout
    setInterval?: typeof setInterval
    clearInterval?: typeof clearInterval
    queueMicrotask?: typeof queueMicrotask
    Promise: PromiseConstructor
  }

  // ---------- console -------------------------------------------------------
  // Zipline pre-injects console.{log,info,warn,error}. On iOS-JSC nothing is
  // pre-injected. Always rewire through __hostLog so dev / Sentry see the
  // logs; preserve the pre-injected console.log behaviour underneath when
  // Zipline ships one (so the same string still surfaces to logcat).
  function installConsole(): void {
    const safeStringify = (args: unknown[]): string => {
      try {
        return JSON.stringify(
          args.map((a) => {
            if (a instanceof Error) {
              return {__error: true, name: a.name, message: a.message, stack: a.stack}
            }
            return a
          }),
        )
      } catch {
        // Cyclic? Fallback to toString. Worst case we lose structure but
        // never crash the host.
        return JSON.stringify(args.map((a) => String(a)))
      }
    }
    const make = (level: string, prev?: (...a: unknown[]) => void) => {
      return (...args: unknown[]) => {
        try {
          __hostLog(level, safeStringify(args))
        } catch {
          // host might not be ready; swallow
        }
        if (prev) {
          try {
            prev(...args)
          } catch {
            // ignore — native sink already received it
          }
        }
      }
    }
    const prevConsole = g.console
    const c = {
      log: make("log", prevConsole?.log?.bind(prevConsole)),
      info: make("info", prevConsole?.info?.bind(prevConsole)),
      warn: make("warn", prevConsole?.warn?.bind(prevConsole)),
      error: make("error", prevConsole?.error?.bind(prevConsole)),
      debug: make("debug", prevConsole?.debug?.bind(prevConsole)),
      trace: make("trace", prevConsole?.trace?.bind(prevConsole)),
    } as unknown as Console
    g.console = c
  }
  installConsole()

  // ---------- error / rejection rewiring ------------------------------------
  // window.onerror is a DOM concept. JSC / QuickJS still let us install a
  // global onerror property; we also wire process.on('unhandledRejection')
  // style by listening on Promise.reject through a microtask trampoline.
  ;(g as unknown as {onerror?: (msg: string, src?: string, line?: number, col?: number, err?: Error) => void}).onerror =
    (msg, src, line, col, err) => {
      try {
        __hostError(
          JSON.stringify({
            message: String(msg),
            src: src ?? "",
            line: line ?? 0,
            col: col ?? 0,
            stack: err && err.stack ? err.stack : "",
          }),
        )
      } catch {
        // host not ready
      }
      return false
    }
  // Promise.reject hook: replace Promise to capture unhandled rejections.
  // QuickJS and JSC both fire host promise rejection tracking callbacks at
  // the engine level but those don't reach JS; we approximate via a
  // microtask-trampolined hook on the prototype.
  try {
    const origThen = g.Promise.prototype.then
    const seen = new WeakSet<Promise<unknown>>()
    g.Promise.prototype.then = function patchedThen(
      this: Promise<unknown>,
      onFulfilled?: ((v: unknown) => unknown) | null,
      onRejected?: ((r: unknown) => unknown) | null,
    ) {
      seen.add(this)
      return origThen.call(this, onFulfilled, onRejected)
    } as PromiseConstructor["prototype"]["then"]
    // Promises whose `then`/`catch` is never called and which reject get
    // collected. Without engine hooks we can only catch ones that the
    // miniapp explicitly logs; rely on engine-level callbacks for real
    // coverage. We at least expose a helper miniapps can use:
    ;(g as Record<string, unknown>).__reportUnhandledRejection = (reason: unknown) => {
      try {
        __hostUnhandledRejection(
          JSON.stringify({
            reason: reason instanceof Error ? {message: reason.message, stack: reason.stack} : reason,
          }),
        )
      } catch {
        // host not ready
      }
    }
  } catch {
    // ignore — Promise prototype frozen in some weird builds
  }

  // ---------- timers --------------------------------------------------------
  // Native owns the scheduler — we install thin JS wrappers that track the
  // callback and arguments by an opaque integer token. Native calls back via
  // globalThis.__deliverTimer(token) when the timer fires.
  // Zipline pre-injects setTimeout/clearTimeout on Android, so we guard.
  function installTimers(): void {
    const callbacks = new Map<number, {fn: () => void; repeating: boolean; interval: number}>()
    let nextToken = 1
    ;(g as Record<string, unknown>).__deliverTimer = (token: number) => {
      const entry = callbacks.get(token)
      if (!entry) return
      try {
        entry.fn()
      } catch (e) {
        try {
          __hostError(
            JSON.stringify({
              message: e instanceof Error ? e.message : String(e),
              stack: e instanceof Error ? e.stack : undefined,
              source: "timer",
              token,
            }),
          )
        } catch {
          /* ignore */
        }
      }
      if (entry.repeating) {
        // Re-schedule another tick. Native is the source of truth for
        // wall-clock; we just bounce the request back.
        try {
          __nativeSetTimeout(token, entry.interval)
        } catch {
          callbacks.delete(token)
        }
      } else {
        callbacks.delete(token)
      }
    }

    const installSetTimeout = (g.setTimeout == null) || (g as Record<string, unknown>).__mentraOwnsSetTimeout
    if (installSetTimeout) {
      g.setTimeout = ((fn: (...args: unknown[]) => void, delayMs?: number, ...rest: unknown[]) => {
        const token = nextToken++
        const ms = typeof delayMs === "number" ? Math.max(0, delayMs) : 0
        callbacks.set(token, {
          fn: () => fn(...rest),
          repeating: false,
          interval: ms,
        })
        try {
          __nativeSetTimeout(token, ms)
        } catch {
          callbacks.delete(token)
          return -1 as unknown as ReturnType<typeof setTimeout>
        }
        return token as unknown as ReturnType<typeof setTimeout>
      }) as typeof setTimeout
      g.clearTimeout = ((token?: number) => {
        if (typeof token !== "number") return
        callbacks.delete(token)
        try {
          __nativeClearTimer(token)
        } catch {
          /* native may already have evicted */
        }
      }) as typeof clearTimeout
      ;(g as Record<string, unknown>).__mentraOwnsSetTimeout = true
    }

    g.setInterval = ((fn: (...args: unknown[]) => void, delayMs?: number, ...rest: unknown[]) => {
      const token = nextToken++
      const ms = typeof delayMs === "number" ? Math.max(0, delayMs) : 0
      callbacks.set(token, {
        fn: () => fn(...rest),
        repeating: true,
        interval: ms,
      })
      try {
        __nativeSetTimeout(token, ms)
      } catch {
        callbacks.delete(token)
        return -1 as unknown as ReturnType<typeof setInterval>
      }
      return token as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval

    g.clearInterval = ((token?: number) => {
      if (typeof token !== "number") return
      callbacks.delete(token)
      try {
        __nativeClearTimer(token)
      } catch {
        /* native may already have evicted */
      }
    }) as typeof clearInterval

    if (typeof g.queueMicrotask !== "function") {
      // Promise.resolve().then(fn) is the universal microtask path; both JSC
      // and QuickJS schedule the .then callback on the microtask queue.
      g.queueMicrotask = ((cb: () => void) => {
        g.Promise.resolve().then(() => {
          try {
            cb()
          } catch (e) {
            try {
              __hostError(
                JSON.stringify({
                  message: e instanceof Error ? e.message : String(e),
                  stack: e instanceof Error ? e.stack : undefined,
                  source: "queueMicrotask",
                }),
              )
            } catch {
              /* ignore */
            }
          }
        })
      }) as typeof queueMicrotask
    }
  }
  installTimers()

  // ---------- AbortController / AbortSignal --------------------------------
  // JSC + QuickJS don't ship the DOM AbortController. The miniapp SDK
  // uses it for RPC cancellation (`session.ui.handle`'s ctx.signal and
  // `mentra.request`'s options.signal). We install a minimal polyfill
  // covering the surface that ships in the SDK:
  //   - new AbortController()
  //   - ctrl.signal, ctrl.abort(reason?)
  //   - signal.aborted, signal.reason
  //   - signal.addEventListener("abort", cb) / removeEventListener
  //   - AbortSignal.any([...])
  // No EventTarget inheritance — the SDK only listens for "abort" so we
  // keep the impl simple (a `Set<cb>` per signal).
  function installAbortController(): void {
    if (typeof (g as Record<string, unknown>).AbortController === "function") return

    type Listener = () => void
    class MentraAbortSignal {
      aborted = false
      reason: unknown = undefined
      private listeners: Set<Listener> = new Set()
      addEventListener(type: string, cb: Listener): void {
        if (type !== "abort" || typeof cb !== "function") return
        if (this.aborted) {
          try { cb() } catch { /* swallow */ }
          return
        }
        this.listeners.add(cb)
      }
      removeEventListener(type: string, cb: Listener): void {
        if (type !== "abort") return
        this.listeners.delete(cb)
      }
      /** @internal — only invoked by the owning AbortController.abort(). */
      __fire(reason: unknown): void {
        if (this.aborted) return
        this.aborted = true
        this.reason = reason
        for (const cb of this.listeners) {
          try { cb() } catch { /* swallow */ }
        }
        this.listeners.clear()
      }
    }
    class MentraAbortController {
      readonly signal: MentraAbortSignal = new MentraAbortSignal()
      abort(reason?: unknown): void {
        this.signal.__fire(reason ?? new Error("aborted"))
      }
    }
    // `AbortSignal.any([signals])` — composes a single signal that aborts
    // when any input does. Used by useRpc's mergeSignals fallback.
    ;(MentraAbortSignal as unknown as {any: (signals: MentraAbortSignal[]) => MentraAbortSignal}).any =
      (signals: MentraAbortSignal[]): MentraAbortSignal => {
        const out = new MentraAbortSignal()
        const onAbort = (s: MentraAbortSignal): void => {
          if (!out.aborted) out.__fire(s.reason)
        }
        for (const s of signals) {
          if (s.aborted) {
            onAbort(s)
            break
          }
          s.addEventListener("abort", () => onAbort(s))
        }
        return out
      }
    ;(g as Record<string, unknown>).AbortController = MentraAbortController
    ;(g as Record<string, unknown>).AbortSignal = MentraAbortSignal
  }
  installAbortController()

  // ---------- dispatch / deliver -------------------------------------------
  // Request/response correlator. SDK code calls into __dispatch through a
  // thin helper that returns a Promise; the host posts back via __deliver.
  const pending = new Map<string, {resolve: (v: unknown) => void; reject: (e: unknown) => void}>()
  let nextReqId = 1

  ;(g as Record<string, unknown>).__deliver = (envelopeJson: string) => {
    let env: {
      kind?: string
      sessionId?: string
      reqId?: string
      iface?: string
      payload?: unknown
      result?: unknown
      ok?: boolean
      error?: {code: string; message?: string; details?: Record<string, unknown>}
    }
    try {
      env = JSON.parse(envelopeJson)
    } catch {
      try {
        __hostError(JSON.stringify({message: "Bad __deliver envelope JSON", source: "__deliver"}))
      } catch {
        /* ignore */
      }
      return
    }
    if (env.kind === "response" && env.reqId) {
      const handlers = pending.get(env.reqId)
      if (handlers) {
        pending.delete(env.reqId)
        if (env.ok) {
          handlers.resolve(env.result)
        } else {
          handlers.reject(env.error ?? {code: "NATIVE_THROW", message: "Unknown native error"})
        }
      }
      return
    }
    if (env.kind === "event" && typeof env.iface === "string") {
      // Fan-out is handled by the SDK side. We just publish on a
      // well-known global the SDK listens to.
      const listeners = ((g as Record<string, unknown>).__mentraEventListeners ?? new Map()) as Map<
        string,
        Set<(p: unknown) => void>
      >
      const set = listeners.get(env.iface)
      if (set) {
        for (const l of set) {
          try {
            l(env.payload)
          } catch (e) {
            try {
              __hostError(
                JSON.stringify({
                  message: e instanceof Error ? e.message : String(e),
                  stack: e instanceof Error ? e.stack : undefined,
                  source: `event:${env.iface}`,
                }),
              )
            } catch {
              /* ignore */
            }
          }
        }
      }
      return
    }
    if (env.kind === "ws-event") {
      const wsHook = (g as Record<string, unknown>).__mentraDeliverWebSocketEvent as
        | ((sid: string, type: string, payload: Record<string, unknown>) => void)
        | undefined
      const sid = (env as {sid?: string}).sid
      const wsType = (env as {wsType?: string}).wsType
      if (typeof wsHook === "function" && typeof sid === "string" && typeof wsType === "string") {
        wsHook(sid, wsType, (env as unknown as {payload?: Record<string, unknown>}).payload ?? {})
      }
      return
    }
    if (env.kind === "bridge" && typeof (env as {raw?: unknown}).raw === "string") {
      // Host pushes a raw SDK envelope (DISPLAY / SUBSCRIBE /
      // STATE_FOR_BRIDGE / etc.) to be delivered into DispatchTransport's
      // onMessage handler. The transport installs this hook on open().
      const deliver = (g as Record<string, unknown>).__mentraDeliverBridgeRaw as ((raw: string) => void) | undefined
      if (typeof deliver === "function") {
        deliver((env as {raw: string}).raw)
      }
      return
    }
    if (env.kind === "init" && typeof env.sessionId === "string") {
      // Stamp the global; the SDK's session factory consumes this to build
      // the typed MiniappSession.
      ;(g as Record<string, unknown>).__mentraSessionId = env.sessionId
      const initCb = (g as Record<string, unknown>).__mentraInitCallback as ((sid: string) => void) | undefined
      if (initCb) initCb(env.sessionId)
    }
  }

  // SDK helpers exposed for the typed wrappers. The SDK is the only caller.
  ;(g as Record<string, unknown>).__mentraSendOneShot = (iface: string, method: string, args: unknown[]) => {
    try {
      __dispatch(iface, method, JSON.stringify(args ?? []))
    } catch (e) {
      try {
        __hostError(
          JSON.stringify({
            message: e instanceof Error ? e.message : String(e),
            source: `oneShot:${iface}.${method}`,
          }),
        )
      } catch {
        /* ignore */
      }
    }
  }

  ;(g as Record<string, unknown>).__mentraSendRequest = (
    iface: string,
    method: string,
    args: unknown[],
  ): Promise<unknown> => {
    return new g.Promise<unknown>((resolve, reject) => {
      const reqId = `${nextReqId++}`
      pending.set(reqId, {resolve, reject})
      try {
        __dispatch(iface, method, JSON.stringify({args: args ?? [], reqId}))
      } catch (e) {
        pending.delete(reqId)
        reject({code: "NATIVE_THROW", message: e instanceof Error ? e.message : String(e)})
      }
    })
  }

  // Event subscribe / unsubscribe helpers — the SDK's session._subscribe()
  // path calls these. We keep the map on globalThis so __deliver can fan
  // out without re-importing this module.
  ;(g as Record<string, unknown>).__mentraEventListeners = new Map<string, Set<(p: unknown) => void>>()
  ;(g as Record<string, unknown>).__mentraSubscribe = (iface: string, cb: (p: unknown) => void) => {
    const map = (g as Record<string, unknown>).__mentraEventListeners as Map<string, Set<(p: unknown) => void>>
    let set = map.get(iface)
    if (!set) {
      set = new Set()
      map.set(iface, set)
    }
    set.add(cb)
    return () => {
      set!.delete(cb)
    }
  }

  // ---------- localStorage --------------------------------------------------
  // Bridged through __dispatch — `localStorage` iface. Storage is per-miniapp
  // (native side scopes by packageName), so the contract is just (key, value)
  // string-string pairs. We don't do quota enforcement on the JS side.
  type DispatchLike = (iface: string, method: string, args: unknown[]) => unknown
  const dispatchSyncOrNull = (iface: string, method: string, args: unknown[]): unknown => {
    try {
      const raw = __dispatch(iface, method, JSON.stringify(args ?? []))
      if (raw == null) return null
      try {
        return JSON.parse(raw)
      } catch {
        return raw
      }
    } catch {
      return null
    }
  }
  ;(g as Record<string, unknown>).__mentraDispatchSync = dispatchSyncOrNull as DispatchLike

  const localStorage = {
    getItem(key: string): string | null {
      const v = dispatchSyncOrNull("localStorage", "getItem", [String(key)])
      return typeof v === "string" ? v : null
    },
    setItem(key: string, value: string): void {
      dispatchSyncOrNull("localStorage", "setItem", [String(key), String(value)])
    },
    removeItem(key: string): void {
      dispatchSyncOrNull("localStorage", "removeItem", [String(key)])
    },
    clear(): void {
      dispatchSyncOrNull("localStorage", "clear", [])
    },
    key(index: number): string | null {
      const v = dispatchSyncOrNull("localStorage", "key", [Number(index)])
      return typeof v === "string" ? v : null
    },
    get length(): number {
      const v = dispatchSyncOrNull("localStorage", "length", [])
      return typeof v === "number" ? v : 0
    },
  }
  ;(g as Record<string, unknown>).localStorage = localStorage

  // ---------- crypto.getRandomValues + randomUUID --------------------------
  // crypto.subtle is wired through __dispatch in a later phase; for v1 we
  // ship just enough for crypto.randomUUID + getRandomValues, which the
  // existing SDK envelope code calls (see envelope.ts → reqId UUID).
  const cryptoNs = (((g as Record<string, unknown>).crypto as Record<string, unknown> | undefined) ?? {}) as Record<
    string,
    unknown
  >
  if (typeof cryptoNs.getRandomValues !== "function") {
    cryptoNs.getRandomValues = (arr: ArrayBufferView) => {
      const bytes = dispatchSyncOrNull("crypto", "getRandomBytes", [arr.byteLength]) as number[] | null
      if (!Array.isArray(bytes) || bytes.length !== arr.byteLength) {
        // Fallback path is "best-effort, not cryptographically strong"; the
        // host should always satisfy this call. Math.random keeps tests
        // running but production native MUST implement getRandomBytes.
        const view = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)
        for (let i = 0; i < view.length; i++) view[i] = Math.floor(Math.random() * 256)
      } else {
        const view = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)
        for (let i = 0; i < bytes.length; i++) view[i] = bytes[i]! & 0xff
      }
      return arr
    }
  }
  if (typeof cryptoNs.randomUUID !== "function") {
    cryptoNs.randomUUID = (): string => {
      // RFC 4122 v4. Pull 16 random bytes then format.
      const buf = new Uint8Array(16)
      ;(cryptoNs.getRandomValues as (a: Uint8Array) => Uint8Array)(buf)
      buf[6] = (buf[6]! & 0x0f) | 0x40
      buf[8] = (buf[8]! & 0x3f) | 0x80
      const hex = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("")
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    }
  }
  // crypto.subtle is deferred to a follow-up (SHA / AES-GCM / HMAC /
  // X25519 over CryptoKit on iOS + javax.crypto + Tink on Android).
  // Until then, miniapps that reach for it get a clear runtime error
  // pointing at the SDK gap instead of an "undefined is not a function"
  // from the engine. Cheaper than silent failures for early authors.
  if (!cryptoNs.subtle) {
    const notImplemented = () => {
      throw new Error(
        "crypto.subtle is not yet implemented in MentraJS — see " +
          "agents/mentrajs-two-layer-miniapp-architecture.md (Polyfill " +
          "strategy section). Use a pure-JS hash/encrypt library for now.",
      )
    }
    cryptoNs.subtle = new Proxy(
      {},
      {
        get: () => notImplemented,
      },
    )
  }
  ;(g as Record<string, unknown>).crypto = cryptoNs

  // ---------- TextEncoder / TextDecoder ------------------------------------
  // Both engines lack these. Tiny implementations sufficient for the SDK's
  // existing usage (UTF-8 only; we don't expose stream encoding because the
  // miniapp doesn't need it).
  if (typeof (g as Record<string, unknown>).TextEncoder !== "function") {
    class TextEncoderPolyfill {
      readonly encoding = "utf-8"
      encode(input?: string): Uint8Array {
        const str = input ?? ""
        const out: number[] = []
        for (let i = 0; i < str.length; i++) {
          let code = str.charCodeAt(i)
          if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
            const next = str.charCodeAt(i + 1)
            if (next >= 0xdc00 && next <= 0xdfff) {
              code = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000
              i++
            }
          }
          if (code < 0x80) {
            out.push(code)
          } else if (code < 0x800) {
            out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
          } else if (code < 0x10000) {
            out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
          } else {
            out.push(
              0xf0 | (code >> 18),
              0x80 | ((code >> 12) & 0x3f),
              0x80 | ((code >> 6) & 0x3f),
              0x80 | (code & 0x3f),
            )
          }
        }
        return new Uint8Array(out)
      }
    }
    ;(g as Record<string, unknown>).TextEncoder = TextEncoderPolyfill
  }
  if (typeof (g as Record<string, unknown>).TextDecoder !== "function") {
    class TextDecoderPolyfill {
      readonly encoding: string
      constructor(encoding = "utf-8") {
        this.encoding = encoding
      }
      decode(buffer?: ArrayBuffer | ArrayBufferView | null): string {
        if (!buffer) return ""
        const bytes =
          buffer instanceof Uint8Array
            ? buffer
            : buffer instanceof ArrayBuffer
              ? new Uint8Array(buffer)
              : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
        let out = ""
        let i = 0
        while (i < bytes.length) {
          const b1 = bytes[i++]!
          let code: number
          if (b1 < 0x80) {
            code = b1
          } else if (b1 < 0xc0) {
            // Invalid start byte; emit replacement character.
            code = 0xfffd
          } else if (b1 < 0xe0) {
            code = ((b1 & 0x1f) << 6) | (bytes[i++]! & 0x3f)
          } else if (b1 < 0xf0) {
            code = ((b1 & 0x0f) << 12) | ((bytes[i++]! & 0x3f) << 6) | (bytes[i++]! & 0x3f)
          } else {
            code =
              ((b1 & 0x07) << 18) |
              ((bytes[i++]! & 0x3f) << 12) |
              ((bytes[i++]! & 0x3f) << 6) |
              (bytes[i++]! & 0x3f)
          }
          if (code > 0xffff) {
            code -= 0x10000
            out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff))
          } else {
            out += String.fromCharCode(code)
          }
        }
        return out
      }
    }
    ;(g as Record<string, unknown>).TextDecoder = TextDecoderPolyfill
  }

  // ---------- atob / btoa --------------------------------------------------
  if (typeof (g as Record<string, unknown>).btoa !== "function") {
    const b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    ;(g as Record<string, unknown>).btoa = (input: string) => {
      let out = ""
      let i = 0
      while (i < input.length) {
        const c1 = input.charCodeAt(i++)
        const c2 = i < input.length ? input.charCodeAt(i++) : NaN
        const c3 = i < input.length ? input.charCodeAt(i++) : NaN
        const e1 = c1 >> 2
        const e2 = ((c1 & 3) << 4) | (Number.isNaN(c2) ? 0 : c2 >> 4)
        const e3 = Number.isNaN(c2) ? 64 : ((c2 & 15) << 2) | (Number.isNaN(c3) ? 0 : c3 >> 6)
        const e4 = Number.isNaN(c3) ? 64 : c3 & 63
        out += b64[e1]! + b64[e2]! + (e3 === 64 ? "=" : b64[e3]!) + (e4 === 64 ? "=" : b64[e4]!)
      }
      return out
    }
    ;(g as Record<string, unknown>).atob = (input: string) => {
      const clean = input.replace(/=+$/, "")
      let out = ""
      let buf = 0
      let bits = 0
      for (let i = 0; i < clean.length; i++) {
        const idx = b64.indexOf(clean[i]!)
        if (idx < 0) continue
        buf = (buf << 6) | idx
        bits += 6
        if (bits >= 8) {
          bits -= 8
          out += String.fromCharCode((buf >> bits) & 0xff)
        }
      }
      return out
    }
  }

  // ---------- fetch (thin native bridge) -----------------------------------
  // Async — uses __mentraSendRequest under the hood with iface "fetch". The
  // native handler is expected to return {status, statusText, headers, body}
  // where body is either a JSON-encodable value or a base64 string.
  if (typeof (g as Record<string, unknown>).fetch !== "function") {
    ;(g as Record<string, unknown>).fetch = async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString()
      const method = (init?.method ?? "GET").toUpperCase()
      let bodyString: string | null = null
      const reqBody = init?.body as unknown
      if (typeof reqBody === "string") {
        bodyString = reqBody
      } else if (reqBody && typeof (reqBody as {toString?: () => string}).toString === "function") {
        bodyString = (reqBody as {toString: () => string}).toString()
      }
      const headers: Record<string, string> = {}
      const rawHeaders = init?.headers
      if (rawHeaders) {
        // Headers-like / record / array of tuples
        if (Array.isArray(rawHeaders)) {
          for (const [k, v] of rawHeaders) {
            if (k != null) headers[String(k)] = String(v)
          }
        } else if (typeof (rawHeaders as Headers).forEach === "function") {
          ;(rawHeaders as Headers).forEach((v, k) => {
            headers[k] = v
          })
        } else {
          for (const [k, v] of Object.entries(rawHeaders as Record<string, string>)) {
            headers[String(k)] = String(v)
          }
        }
      }
      const sendRequest = (g as Record<string, unknown>).__mentraSendRequest as (
        iface: string,
        method: string,
        args: unknown[],
      ) => Promise<unknown>
      const result = (await sendRequest("fetch", "request", [
        {url, method, headers, body: bodyString},
      ])) as {
        status: number
        statusText?: string
        headers?: Record<string, string>
        body?: string | null
        ok?: boolean
      }
      const bodyText = typeof result.body === "string" ? result.body : ""
      const responseHeaders = new Map(Object.entries(result.headers ?? {}))
      // Minimal Response polyfill — enough for SDK usage.
      class ResponseLike {
        readonly status = result.status
        readonly statusText = result.statusText ?? ""
        readonly ok = result.ok ?? (result.status >= 200 && result.status < 300)
        readonly url = url
        readonly headers = {
          get: (k: string) => responseHeaders.get(k.toLowerCase()) ?? null,
          has: (k: string) => responseHeaders.has(k.toLowerCase()),
          forEach: (cb: (v: string, k: string) => void) => {
            for (const [k, v] of responseHeaders) cb(v, k)
          },
        }
        async text(): Promise<string> {
          return bodyText
        }
        async json(): Promise<unknown> {
          try {
            return JSON.parse(bodyText)
          } catch (e) {
            // Match the browser fetch().json() behaviour — a SyntaxError
            // is thrown that names the response in its message so the
            // miniapp author can tell which call failed.
            const err = new Error(
              `Failed to parse JSON response from ${url}: ${
                e instanceof Error ? e.message : String(e)
              }`,
            )
            ;(err as Error & {name: string}).name = "SyntaxError"
            throw err
          }
        }
        async arrayBuffer(): Promise<ArrayBuffer> {
          const enc = new (g as unknown as {TextEncoder: new () => TextEncoder}).TextEncoder()
          return enc.encode(bodyText).buffer as ArrayBuffer
        }
      }
      return new ResponseLike()
    }
  }

  // ---------- WebSocket ----------------------------------------------------
  // Native bridge over URLSessionWebSocketTask (iOS) / OkHttp WebSocket
  // (Android). The JS shim is an EventTarget-shaped wrapper that opens a
  // session id via `__dispatch("ws", "open", [{url, protocols, headers}])`
  // and routes inbound `{kind: "ws-event", sid, ...}` envelopes from
  // __deliver into the matching socket's listeners.
  //
  // RFC 6455 readyState constants: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED.
  if (typeof (g as Record<string, unknown>).WebSocket !== "function") {
    type WSListener = (ev: Record<string, unknown>) => void

    const sockets = new Map<string, MentraWebSocket>()

    // __deliver fans out ws-event envelopes here. Installed once; the
    // existing __deliver dispatcher (event/response/bridge/init) walks
    // its kind-switch and falls through to this hook for ws-event.
    ;(g as Record<string, unknown>).__mentraDeliverWebSocketEvent = (
      sid: string,
      type: "open" | "message" | "error" | "close",
      payload: Record<string, unknown> | undefined,
    ) => {
      const sock = sockets.get(sid)
      if (!sock) return
      sock._deliver(type, payload ?? {})
    }

    class MentraWebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSING = 2
      static readonly CLOSED = 3

      readonly CONNECTING = 0
      readonly OPEN = 1
      readonly CLOSING = 2
      readonly CLOSED = 3

      url: string
      readyState: number = 0
      bufferedAmount = 0
      extensions = ""
      protocol = ""
      binaryType: "blob" | "arraybuffer" = "arraybuffer"

      onopen: WSListener | null = null
      onmessage: WSListener | null = null
      onerror: WSListener | null = null
      onclose: WSListener | null = null

      private listeners: Record<string, Set<WSListener>> = {
        open: new Set(),
        message: new Set(),
        error: new Set(),
        close: new Set(),
      }
      private sid: string

      constructor(url: string, protocols?: string | string[]) {
        this.url = String(url)
        const protoList = Array.isArray(protocols) ? protocols : protocols ? [protocols] : []
        // Allocate a session id JS-side so the dispatcher's response is a
        // simple ack rather than carrying the sid we then have to wait for.
        this.sid = `ws-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
        sockets.set(this.sid, this)
        try {
          __dispatch(
            "ws",
            "open",
            JSON.stringify([{sid: this.sid, url: this.url, protocols: protoList}]),
          )
        } catch (e) {
          // Native bridge unavailable — synthesize an immediate failure.
          this.readyState = 3
          queueMicrotaskSafe(() => this._deliver("error", {message: String(e)}))
          queueMicrotaskSafe(() => this._deliver("close", {code: 1006, reason: "bridge unavailable"}))
        }
      }

      addEventListener(type: string, cb: WSListener): void {
        if (!this.listeners[type]) this.listeners[type] = new Set()
        this.listeners[type].add(cb)
      }

      removeEventListener(type: string, cb: WSListener): void {
        this.listeners[type]?.delete(cb)
      }

      send(data: string | ArrayBuffer | ArrayBufferView): void {
        if (this.readyState === 3) {
          throw new Error("WebSocket is already in CLOSING or CLOSED state.")
        }
        let kind: "text" | "binary"
        let payload: string
        if (typeof data === "string") {
          kind = "text"
          payload = data
        } else {
          kind = "binary"
          const bytes =
            data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          payload = bytesToBase64(bytes)
        }
        // bufferedAmount is intentionally a static 0 — native owns the
        // real queue (URLSessionWebSocketTask / OkHttp); reading it
        // accurately from JS requires a synchronous round-trip we
        // don't expose. No production miniapp surveyed observes it.
        try {
          __dispatch("ws", "send", JSON.stringify([{sid: this.sid, kind, payload}]))
        } catch (e) {
          this._deliver("error", {message: String(e)})
        }
      }

      close(code?: number, reason?: string): void {
        if (this.readyState === 2 || this.readyState === 3) return
        this.readyState = 2
        try {
          __dispatch(
            "ws",
            "close",
            JSON.stringify([{sid: this.sid, code: code ?? 1000, reason: reason ?? ""}]),
          )
        } catch (e) {
          // Treat native failure as immediate close.
          this.readyState = 3
          this._deliver("close", {code: 1006, reason: String(e)})
        }
      }

      /** @internal — called by __deliver via the global hook. */
      _deliver(type: "open" | "message" | "error" | "close", ev: Record<string, unknown>): void {
        if (type === "open") {
          this.readyState = 1
          if (typeof ev.protocol === "string") this.protocol = ev.protocol
        } else if (type === "close") {
          this.readyState = 3
          sockets.delete(this.sid)
        }
        const synth: Record<string, unknown> = {type, target: this, ...ev}
        // Reconstitute binary frames into ArrayBuffer for arraybuffer
        // binaryType (the default we ship; no Blob shim yet).
        if (type === "message" && ev.kind === "binary" && typeof ev.data === "string") {
          synth.data = base64ToBytes(ev.data).buffer
        } else if (type === "message" && ev.kind === "text") {
          synth.data = ev.data
        }
        const propMap: Record<string, "onopen" | "onmessage" | "onerror" | "onclose"> = {
          open: "onopen",
          message: "onmessage",
          error: "onerror",
          close: "onclose",
        }
        const prop = propMap[type]
        const handler = (this as Record<string, unknown>)[prop] as WSListener | null
        if (handler) {
          try {
            handler(synth)
          } catch (e) {
            try {
              __hostError(
                JSON.stringify({
                  message: e instanceof Error ? e.message : String(e),
                  source: `WebSocket.${prop}`,
                }),
              )
            } catch {
              /* ignore */
            }
          }
        }
        const set = this.listeners[type]
        if (set) {
          for (const cb of set) {
            try {
              cb(synth)
            } catch (e) {
              try {
                __hostError(
                  JSON.stringify({
                    message: e instanceof Error ? e.message : String(e),
                    source: `WebSocket.addEventListener("${type}")`,
                  }),
                )
              } catch {
                /* ignore */
              }
            }
          }
        }
      }
    }

    function bytesToBase64(bytes: Uint8Array): string {
      const b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
      let out = ""
      let i = 0
      while (i < bytes.length) {
        const c1 = bytes[i++]!
        const c2 = i < bytes.length ? bytes[i++]! : NaN
        const c3 = i < bytes.length ? bytes[i++]! : NaN
        const e1 = c1 >> 2
        const e2 = ((c1 & 3) << 4) | (Number.isNaN(c2) ? 0 : c2 >> 4)
        const e3 = Number.isNaN(c2) ? 64 : ((c2 & 15) << 2) | (Number.isNaN(c3) ? 0 : c3 >> 6)
        const e4 = Number.isNaN(c3) ? 64 : c3 & 63
        out += b64[e1]! + b64[e2]! + (e3 === 64 ? "=" : b64[e3]!) + (e4 === 64 ? "=" : b64[e4]!)
      }
      return out
    }
    function base64ToBytes(s: string): Uint8Array {
      const b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
      const clean = s.replace(/=+$/, "")
      const out: number[] = []
      let buf = 0
      let bits = 0
      for (let i = 0; i < clean.length; i++) {
        const idx = b64.indexOf(clean[i]!)
        if (idx < 0) continue
        buf = (buf << 6) | idx
        bits += 6
        if (bits >= 8) {
          bits -= 8
          out.push((buf >> bits) & 0xff)
        }
      }
      return new Uint8Array(out)
    }
    function queueMicrotaskSafe(fn: () => void): void {
      const q = (g as Record<string, unknown>).queueMicrotask as ((cb: () => void) => void) | undefined
      if (typeof q === "function") q(fn)
      else g.Promise.resolve().then(fn)
    }

    ;(g as Record<string, unknown>).WebSocket = MentraWebSocket
  }

  // ---------- signal ready --------------------------------------------------
  // Tell the native host we're done installing. Host has a NACK timer
  // (15s cold-start / 3s steady-state) that arms before spawn and clears
  // when this fires. The host also re-fires the timer for every
  // dispatchToJs so the host knows the miniapp's event loop is alive.
  try {
    __dispatch("__runtime", "ready", JSON.stringify([]))
  } catch {
    // Tests may not have __dispatch installed; ignore.
  }
})()
