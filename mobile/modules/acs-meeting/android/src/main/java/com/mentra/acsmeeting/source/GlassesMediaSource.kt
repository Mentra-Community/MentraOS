package com.mentra.acsmeeting.source

enum class SourceKind { WHEP, DIRECT }

enum class SourceState { IDLE, CONNECTING, LIVE, FAILED }

data class SourceConfig(
  val url: String,
  val kind: SourceKind = SourceKind.WHEP,
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
  fun setPcmDeliveryEnabled(enabled: Boolean)
  fun setTargetSize(size: TargetSize?) {}
  fun setStateListener(listener: SourceStateListener?) {}
}

fun interface GlassesMediaSourceFactory {
  fun create(video: VideoFrameListener, pcm: PcmListener): GlassesMediaSource
}

class GlassesMediaController(
  private val factory: GlassesMediaSourceFactory,
) {
  private var source: GlassesMediaSource? = null
  private var stateListener: SourceStateListener? = null

  val state: SourceState
    get() = source?.state ?: SourceState.IDLE

  fun attach(video: VideoFrameListener, pcm: PcmListener, config: SourceConfig) {
    source?.stop()
    source = factory.create(video, pcm).also {
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
