/**
 * `<StreamPreview>` — draws the raw decoded frames of the source the miniapp's background has
 * leased with `session.stream.preview()`.
 *
 * The component owns only the renderer (canvas, WebGL context, textures). Mounting it shows the
 * preview; unmounting it hides the preview and stops production, but keeps the document's
 * connection open so the next mount starts without a handshake. Releasing the lease is the
 * background's job (`handle.stop()`), not this component's.
 *
 * Frame bytes never enter React state: frames go from the transport to the renderer directly.
 */

import {useEffect, useRef, type CSSProperties} from "react"

import type {PreviewConnectionState, PreviewSink} from "./stream-preview/PreviewConnection"
import {getPreviewConnection} from "./stream-preview/PreviewConnection"
import {ResizeCoalescer, type PreviewBox} from "./stream-preview/resizeCoalescer"
import {quantizePreviewTier, sameTier, type PreviewTier} from "./stream-preview/tiers"
import {previewTrace, previewTraceWarn} from "./stream-preview/trace"
import {createYuvRenderer, type PreviewFit, type YuvRenderer, type YuvRendererOptions} from "./stream-preview/yuvRenderer"

export type {PreviewFit} from "./stream-preview/yuvRenderer"
export type {PreviewConnectionState} from "./stream-preview/PreviewConnection"

export interface StreamPreviewStatus {
  state: PreviewConnectionState
  /** The Mentra App is in the background; production is paused and resumes on return. */
  paused: boolean
  /** Why the state changed, when the host said (`source_ended`, `stopped`, ...). */
  reason?: string
  /** Error code for `error` / `unsupported`. */
  code?: string
  /** Latest once-a-second host counters plus page-side counters. */
  stats?: Record<string, unknown>
}

export interface StreamPreviewProps {
  /** `contain` letterboxes (default); `cover` fills and crops. The picture is never stretched. */
  fit?: PreviewFit
  onStatus?: (status: StreamPreviewStatus) => void
  /** Typed preview error codes: `source_ended`, `unsupported`, `transport_failed`, ... */
  onError?: (code: string) => void
  className?: string
  style?: CSSProperties
}

type RendererFactory = (canvas: HTMLCanvasElement, options: YuvRendererOptions) => YuvRenderer | null

let rendererFactory: RendererFactory = createYuvRenderer

/** Test seam: WebGL is not available in headless DOMs. */
export function setStreamPreviewRendererFactoryForTests(factory: RendererFactory | null): void {
  rendererFactory = factory ?? createYuvRenderer
}

const DEFAULT_STYLE: CSSProperties = {display: "block", width: "100%", height: "100%"}

function measure(canvas: HTMLCanvasElement): PreviewBox {
  const rect = canvas.getBoundingClientRect()
  const ratio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1
  return {width: Math.round(rect.width * ratio), height: Math.round(rect.height * ratio)}
}

function isDocumentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden"
}

export function StreamPreview({fit = "contain", onStatus, onError, className, style}: StreamPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rendererRef = useRef<YuvRenderer | null>(null)
  const fitRef = useRef(fit)
  const onStatusRef = useRef(onStatus)
  const onErrorRef = useRef(onError)
  fitRef.current = fit
  onStatusRef.current = onStatus
  onErrorRef.current = onError

  useEffect(() => {
    rendererRef.current?.setFit(fit)
  }, [fit])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const connection = getPreviewConnection()
    const mountEpoch = connection.nextMountEpoch()
    let contextLosses = 0
    let status: StreamPreviewStatus = {state: connection.currentState, paused: false}
    let box: PreviewBox = {width: 0, height: 0}
    let tier: PreviewTier | null = null
    let running = isDocumentVisible()
    let unmounted = false

    const emit = (next: Partial<StreamPreviewStatus>) => {
      status = {...status, ...next}
      onStatusRef.current?.(status)
    }

    const buildRenderer = () => {
      rendererRef.current?.dispose()
      rendererRef.current = rendererFactory(canvas, {
        fit: fitRef.current,
        onError: (reason) => {
          previewTraceWarn("renderer_error", {reason, mountEpoch, docGen: connection.documentGeneration})
          connection.reportRendererError(mountEpoch, reason)
          if (reason === "webgl_context_lost") contextLosses += 1
        },
      })
      if (!rendererRef.current) connection.reportRendererError(mountEpoch, "webgl_unavailable")
    }
    buildRenderer()

    // Context loss rebuilds only the renderer. The connection and the lease are not involved,
    // and frames that arrive meanwhile are still acked so the sender does not stall.
    const onContextRestored = () => {
      if (unmounted) return
      previewTrace("renderer_rebuilt", {mountEpoch, contextLosses})
      buildRenderer()
    }
    canvas.addEventListener("webglcontextrestored", onContextRestored)

    const sink: PreviewSink = {
      mountEpoch,
      draw: (frame) => rendererRef.current?.drawFrame(frame) ?? null,
      onState: (state, detail) => emit({state, paused: detail.paused ?? false, reason: detail.reason, code: detail.code}),
      onStatus: (stats) => emit({stats: {...stats, contextLosses}}),
      onError: (code) => onErrorRef.current?.(code),
    }
    const detach = connection.attach(sink)
    previewTrace("mount", {mountEpoch, docGen: connection.documentGeneration})

    const push = () => connection.update(mountEpoch, {boxWidth: box.width, boxHeight: box.height, tier, running})

    const coalescer = new ResizeCoalescer({
      apply: (next) => {
        box = next
        const nextTier = quantizePreviewTier(next.width, next.height)
        if (sameTier(nextTier, tier) && tier !== null) return
        tier = nextTier
        if (!tier) previewTrace("hidden_zero_size", {mountEpoch})
        push()
      },
    })

    let resizeObserver: ResizeObserver | null = null
    const onWindowResize = () => coalescer.push(measure(canvas))
    if (typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver(() => coalescer.push(measure(canvas)))
      resizeObserver.observe(canvas)
    } else if (typeof window !== "undefined") {
      window.addEventListener("resize", onWindowResize)
    }
    coalescer.push(measure(canvas))

    const onVisibility = () => {
      const visible = isDocumentVisible()
      if (visible === running) return
      running = visible
      previewTrace("visibility_change", {mountEpoch, visible})
      push()
    }
    document.addEventListener("visibilitychange", onVisibility)

    return () => {
      unmounted = true
      previewTrace("unmount", {mountEpoch, docGen: connection.documentGeneration})
      document.removeEventListener("visibilitychange", onVisibility)
      resizeObserver?.disconnect()
      if (typeof window !== "undefined") window.removeEventListener("resize", onWindowResize)
      coalescer.cancel()
      canvas.removeEventListener("webglcontextrestored", onContextRestored)
      running = false
      push()
      detach()
      rendererRef.current?.dispose()
      rendererRef.current = null
    }
  }, [])

  return <canvas ref={canvasRef} className={className} style={{...DEFAULT_STYLE, ...style}} />
}
