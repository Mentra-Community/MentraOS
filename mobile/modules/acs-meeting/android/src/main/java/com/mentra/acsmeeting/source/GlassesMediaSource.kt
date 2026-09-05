package com.mentra.acsmeeting.source

enum class SourceKind {
  /** Subscribe to a Cloudflare WHEP endpoint. The phone is the offerer. */
  WHEP,
  DIRECT,

  /**
   * Serve a WHIP endpoint on the glasses hotspot and let the glasses publish into it. The phone is
   * the answerer, and no traffic leaves the local link. See [LocalWhipIngestSource].
   */
  SOFTAP,
}

enum class SourceState { IDLE, CONNECTING, LIVE, FAILED }

data class SourceConfig(
  /**
   * WHEP: the endpoint to subscribe to. SOFTAP: unused, because the URL is not known until the
   * listener has bound a port — the source reports it back through
   * [GlassesMediaSource.ingestUrl] instead.
   */
  val url: String,
  val kind: SourceKind = SourceKind.WHEP,
  /** SOFTAP only: the phone's own IPv4 address on the hotspot, to bind the listener to. */
  val bindAddress: String? = null,
)

/** ACS-negotiated output size. One object so a frame cannot observe a torn width/height. */
data class TargetSize(val width: Int, val height: Int)

/**
 * Whether a subscriber already on [currentUrl] can serve [next] as-is instead of
 * being rebuilt.
 *
 * Reuse is the whole point: a rebuild mints a new peer and restarts the wait for
 * the first frame, which is the outage we are trying to shorten. `CONNECTING`
 * counts as reusable, and since `LIVE` means "a frame reached the sink" that now
 * spans the answer → first frame window too. It cannot strand a caller, because
 * every `CONNECTING` is bounded: the offer post fails, or the answer's
 * first-frame deadline expires into `FAILED` and this returns false.
 */
fun canReuseSource(currentUrl: String?, state: SourceState, next: SourceConfig): Boolean =
  currentUrl == next.url && next.kind == SourceKind.WHEP && state != SourceState.FAILED

/**
 * Observes source health transitions. `FAILED` is the one that matters: ICE
 * dropped, the WHEP endpoint went away, or an answered subscription never
 * delivered a frame — and nothing downstream will notice on its own, because
 * ACS keeps the call up with a frozen last frame.
 */
fun interface SourceStateListener {
  fun onSourceState(state: SourceState, reason: String?)
}

/**
 * Transports whatever the glasses already captured. Capture policy lives
 * outside this interface so a Cloudflare hop can be replaced without touching ACS.
 */
interface GlassesMediaSource {
  fun start(config: SourceConfig)
  fun restart(config: SourceConfig)
  /** Rebuild the transport for the current config even if it looks healthy. */
  fun forceRestart() {}
  fun stop()
  val state: SourceState

  /**
   * SOFTAP only: the WHIP URL the glasses must POST their offer to, known only after [start] has
   * bound a listener. Null for every other kind, where the URL is an input rather than an output.
   */
  val ingestUrl: String? get() = null

  fun setPcmDeliveryEnabled(enabled: Boolean)
  fun setTargetSize(size: TargetSize?) {}
  fun setStateListener(listener: SourceStateListener?) {}
}

/**
 * Builds the transport for one attempt. Takes [SourceConfig] because the kind decides the class:
 * a Cloudflare subscription and a SoftAP listener are different objects, not one object with a
 * mode flag, and the session must not have to know which.
 */
fun interface GlassesMediaSourceFactory {
  fun create(video: VideoFrameListener, pcm: PcmListener, config: SourceConfig): GlassesMediaSource
}

class GlassesMediaController(
  private val factory: GlassesMediaSourceFactory,
) {
  private var source: GlassesMediaSource? = null
  private var stateListener: SourceStateListener? = null

  val state: SourceState
    get() = source?.state ?: SourceState.IDLE

  /** SOFTAP only: the URL the glasses must publish to, once a listener has bound. */
  val ingestUrl: String?
    get() = source?.ingestUrl

  fun attach(video: VideoFrameListener, pcm: PcmListener, config: SourceConfig) {
    source?.stop()
    source = factory.create(video, pcm, config).also {
      it.setStateListener(stateListener)
      it.start(config)
    }
  }

  fun restart(config: SourceConfig) {
    source?.restart(config)
  }

  fun forceRestart() {
    source?.forceRestart()
  }

  fun setStateListener(listener: SourceStateListener?) {
    stateListener = listener
    source?.setStateListener(listener)
  }

  fun stop() {
    source?.stop()
    source = null
  }

  fun setPcmDeliveryEnabled(enabled: Boolean) {
    source?.setPcmDeliveryEnabled(enabled)
  }

  fun setTargetSize(size: TargetSize?) {
    source?.setTargetSize(size)
  }
}
