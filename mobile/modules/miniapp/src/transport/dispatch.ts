/**
 * @fileoverview DispatchTransport — Transport implementation that rides
 * the native `__dispatch(iface, method, argsJson)` bridge exposed by the
 * MentraJS runtime (per-miniapp JSContext on iOS-JSC, Zipline/QuickJS
 * context on Android).
 *
 * The existing `MiniappSession` (session.ts) is transport-agnostic — it
 * serialises envelopes into JSON strings and hands them to Transport.send().
 * The native side has historically been on the other end of a
 * `window.ReactNativeWebView.postMessage(...)` shim (PostMessageTransport)
 * inside a WebView. In the new architecture, background JS runs in a
 * JSContext that has no WebView — so the wire is `__dispatch` instead.
 *
 * What this transport does:
 *   - send(raw) — calls __dispatch("__bridge", "send", [raw]). The host
 *     side `MentraJSRouter` consumes the raw string verbatim, same shape
 *     as PostMessageTransport's wire payload.
 *   - The polyfill bundle (`startup.ts`) wires __deliver({kind:'bridge',raw})
 *     back into this transport's message handler so the host can push
 *     unsolicited events (mic_pcm, transcription, button events, etc.)
 *     into the SDK.
 *   - open()/close() are no-ops — the JSContext is alive as long as the
 *     host has the runtime spawned; nothing to handshake here.
 *
 * On Android Zipline `__dispatch` is suspending under the hood; on
 * iOS-JSC it's a synchronous Swift block. Both shapes are JSON-string in,
 * JSON-string out, so the JS-side surface is identical.
 */

import {Transport, TransportDisconnectHandler, TransportMessageHandler} from "./types"

/**
 * Shape of the deliver envelope used by background code to surface
 * RN-originated transport messages back to the SDK. The polyfill bundle
 * fans these into __mentraDeliverBridgeRaw.
 */
interface BridgeDeliverGlobal {
  __mentraDeliverBridgeRaw?: (raw: string) => void
  __dispatch?: (iface: string, method: string, argsJson: string) => string | null
}

export class DispatchTransport implements Transport {
  private messageHandler: TransportMessageHandler | null = null
  private disconnectHandler: TransportDisconnectHandler | null = null
  private open_ = false

  /** True iff `__dispatch` is bound on the current globalThis. */
  static isAvailable(): boolean {
    return typeof (globalThis as unknown as BridgeDeliverGlobal).__dispatch === "function"
  }

  async open(): Promise<void> {
    if (!DispatchTransport.isAvailable()) {
      throw new Error("DispatchTransport: __dispatch is not installed on globalThis")
    }
    // Wire up the inbound delivery hook so the polyfill's __deliver can
    // route bridge frames here. Installed lazily so multiple transports
    // can share the same global if a test spins up two.
    const g = globalThis as unknown as BridgeDeliverGlobal
    g.__mentraDeliverBridgeRaw = (raw: string) => {
      if (this.messageHandler) this.messageHandler(raw)
    }
    this.open_ = true
  }

  send(raw: string): void {
    if (!this.open_) {
      throw new Error("DispatchTransport: send() before open()")
    }
    const g = globalThis as unknown as BridgeDeliverGlobal
    if (typeof g.__dispatch !== "function") {
      // Native bridge gone — surface as a transport-level disconnect so
      // upstream callers don't hang on pending requests.
      this.open_ = false
      this.disconnectHandler?.("DispatchTransport: __dispatch disappeared")
      return
    }
    // Wire format: stringify the args array as a single-element array
    // containing the raw envelope. The router unwraps it.
    try {
      g.__dispatch("__bridge", "send", JSON.stringify([raw]))
    } catch (e) {
      this.disconnectHandler?.(`DispatchTransport: __dispatch threw: ${String(e)}`)
    }
  }

  onMessage(handler: TransportMessageHandler): void {
    this.messageHandler = handler
  }

  onDisconnect(handler: TransportDisconnectHandler): void {
    this.disconnectHandler = handler
  }

  close(): void {
    this.open_ = false
    const g = globalThis as unknown as BridgeDeliverGlobal
    if (g.__mentraDeliverBridgeRaw) {
      delete g.__mentraDeliverBridgeRaw
    }
  }

  isOpen(): boolean {
    return this.open_
  }
}
