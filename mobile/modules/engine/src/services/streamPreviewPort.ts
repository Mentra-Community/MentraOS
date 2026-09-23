/**
 * Seam between the miniapp runtime and the host's stream-preview coordinator.
 *
 * The coordinator lives in the Mentra App (it drives the native frame-preview module and the
 * WebView), while `miniapp_stream_preview_start/stop` arrive here in the runtime. The app installs
 * its coordinator with {@link setStreamPreviewHost}; a host that never does simply answers
 * `unsupported`.
 */

export interface StreamPreviewStartRequest {
  packageName: string
  /** Identifies one spawn of the background runtime; a respawn gets a new one. */
  runtimeId: string
  /** As sent by the miniapp; validated by the coordinator. */
  source: unknown
  /** The miniapp declared `CAMERA` in its manifest. */
  hasCamera: boolean
}

export interface StreamPreviewStartResult {
  handleId: string
  previewTraceId: string
  source: "call"
}

/** Pushed to the lease holder's background as `miniapp_stream_preview_status`. */
export interface StreamPreviewStatusEvent {
  handleId: string
  state: "held" | "ended"
  reason?: string
}

/** A typed refusal: `code` is a preview error code such as `not_meeting_owner`. */
export class StreamPreviewError extends Error {
  readonly code: string

  constructor(code: string, message?: string) {
    super(message ?? code)
    this.name = "StreamPreviewError"
    this.code = code
  }
}

export interface StreamPreviewHostPort {
  /** Rejects with a {@link StreamPreviewError}. `notify` must be dropped once the lease ends. */
  start(request: StreamPreviewStartRequest, notify: (event: StreamPreviewStatusEvent) => void): Promise<StreamPreviewStartResult>
  /** Identity-checked; a stale handle is ignored, not an error. */
  stop(request: {packageName: string; runtimeId: string; handleId: string}): Promise<void>
  /** The background runtime `runtimeId` of `packageName` is gone; release anything it held. */
  releaseRuntime(packageName: string, runtimeId: string, reason: string): void
}

let host: StreamPreviewHostPort | null = null

export function setStreamPreviewHost(next: StreamPreviewHostPort | null): void {
  host = next
}

export function getStreamPreviewHost(): StreamPreviewHostPort | null {
  return host
}
