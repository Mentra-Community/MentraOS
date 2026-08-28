package com.mentra.acsmeeting

enum class SourceKind { WHEP, DIRECT }

enum class SourceState { IDLE, CONNECTING, LIVE, FAILED }

data class SourceConfig(
  val url: String,
  val kind: SourceKind = SourceKind.WHEP,
)

/**
 * Transports whatever the glasses already captured. Capture policy lives
 * outside this interface so a Cloudflare hop can be replaced without touching ACS.
 */
interface GlassesMediaSource {
  fun start(config: SourceConfig)
  fun restart(config: SourceConfig)
  fun stop()
  val state: SourceState
  fun setPcmDeliveryEnabled(enabled: Boolean)
}

fun interface GlassesMediaSourceFactory {
  fun create(video: VideoFrameListener, pcm: PcmListener): GlassesMediaSource
}

class GlassesMediaController(
  private val factory: GlassesMediaSourceFactory,
) {
  private var source: GlassesMediaSource? = null

  val state: SourceState
    get() = source?.state ?: SourceState.IDLE

  fun attach(video: VideoFrameListener, pcm: PcmListener, config: SourceConfig) {
    source?.stop()
    source = factory.create(video, pcm).also { it.start(config) }
  }

  fun restart(config: SourceConfig) {
    source?.restart(config)
  }

  fun stop() {
    source?.stop()
    source = null
  }

  fun setPcmDeliveryEnabled(enabled: Boolean) {
    source?.setPcmDeliveryEnabled(enabled)
  }
}
