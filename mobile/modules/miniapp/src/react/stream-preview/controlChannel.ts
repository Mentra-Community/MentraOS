/**
 * The reserved `_preview` UI channel, as seen from the page.
 *
 * The Mentra App answers this channel itself; it never reaches the miniapp's background. Requests
 * ride `mentra.request`, and host events arrive on `mentra.on("_preview")`. Every control request
 * carries the page identity (`docGen`, `token`, `mountEpoch`) so the host can drop operations
 * from a document or a component that has since been replaced.
 */

import {PREVIEW_UI_CHANNEL} from "../../protocol"

/** `injectFault` is honoured only in debug builds or with the host's hidden developer setting. */
export type PreviewCommand = "handshake" | "configure" | "start" | "stop" | "rendererError" | "injectFault"

export interface PreviewControlRequest {
  cmd: PreviewCommand
  /** 0 until the first handshake has told the page which document it is. */
  docGen: number
  token?: string
  mountEpoch: number
  /** `configure` only: rendered box in device pixels, after rotation. */
  boxWidth?: number
  boxHeight?: number
  /** `rendererError` only. */
  message?: string
  /** `injectFault` only: `ack_delay`, `ack_drop`, `transport_close`, `pack_throw`, `sink_throw`, `clear`. */
  kind?: string
  ms?: number
}

export interface PreviewDocumentConfig {
  t: "config"
  protocolVersion: number
  transport: "webmessage" | "websocket"
  url?: string
  portName?: string
  token: string
  docGen: number
}

export type PreviewHandshakeResult = PreviewDocumentConfig | {t: "waiting_for_lease"; docGen: number}

/** Reply to configure/start/stop. `stale` means the host dropped it; that is not an error. */
export interface PreviewControlReply {
  applied?: boolean
  stale?: boolean
}

export type PreviewHostEvent =
  | PreviewDocumentConfig
  | ({t: "status"} & Record<string, unknown>)
  | {t: "lease_available"}
  | {t: "lease_ended"; reason: string}
  | {t: "error"; code: string; docGen?: number}
  | {t: "paused_background"}
  | {t: "resumed"}

/** A `_preview` request the host refused. `code` is a preview error code. */
export class PreviewControlError extends Error {
  readonly code: string

  constructor(code: string, message?: string) {
    super(message ?? code)
    this.name = "PreviewControlError"
    this.code = code
  }
}

export interface PreviewControlChannel {
  request(request: PreviewControlRequest): Promise<unknown>
  onEvent(cb: (event: PreviewHostEvent) => void): () => void
}

interface MentraLike {
  request(channel: string, payload: unknown, options?: {timeout?: number}): Promise<unknown>
  on(channel: string, cb: (payload: unknown) => void): () => void
}

/** Host replies are local and fast; this only bounds a host that never answers. */
const REQUEST_TIMEOUT_MS = 10_000

function mentraGlobal(): MentraLike | null {
  const candidate = (globalThis as unknown as {mentra?: Partial<MentraLike>}).mentra
  if (!candidate || typeof candidate.request !== "function" || typeof candidate.on !== "function") return null
  return candidate as MentraLike
}

/** The channel over the injected `window.mentra` bridge. Null outside a Mentra App WebView. */
export function createMentraControlChannel(): PreviewControlChannel | null {
  const mentra = mentraGlobal()
  if (!mentra) return null
  return {
    async request(request) {
      try {
        return await mentra.request(PREVIEW_UI_CHANNEL, request, {timeout: REQUEST_TIMEOUT_MS})
      } catch (error) {
        const value = (error ?? {}) as {code?: unknown; name?: unknown; message?: unknown}
        const code =
          typeof value.code === "string"
            ? value.code
            : value.name === "MentraRpcTimeoutError"
              ? "transport_failed"
              : "unsupported"
        throw new PreviewControlError(code, typeof value.message === "string" ? value.message : undefined)
      }
    },
    onEvent(cb) {
      return mentra.on(PREVIEW_UI_CHANNEL, (payload) => {
        if (payload && typeof payload === "object" && typeof (payload as {t?: unknown}).t === "string") {
          cb(payload as PreviewHostEvent)
        }
      })
    },
  }
}
