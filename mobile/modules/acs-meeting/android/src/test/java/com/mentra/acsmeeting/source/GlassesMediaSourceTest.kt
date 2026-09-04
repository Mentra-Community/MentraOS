package com.mentra.acsmeeting.source

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class FakeGlassesMediaSource : GlassesMediaSource {
  val started = mutableListOf<SourceConfig>()
  val restarted = mutableListOf<SourceConfig>()
  var stopped = 0
  var pcmEnabled = true
  var pcmListener: PcmListener? = null
  val targetSizes = mutableListOf<TargetSize?>()
  override var state: SourceState = SourceState.IDLE
    private set

  override fun start(config: SourceConfig) {
    started.add(config)
    state = SourceState.CONNECTING
    state = SourceState.LIVE
  }

  override fun restart(config: SourceConfig) {
    restarted.add(config)
    start(config)
  }

  override fun stop() {
    stopped += 1
    state = SourceState.IDLE
  }

  override fun setPcmDeliveryEnabled(enabled: Boolean) {
    pcmEnabled = enabled
  }

  override fun setTargetSize(size: TargetSize?) {
    targetSizes.add(size)
  }

  fun emitPcm(pcm: ByteArray, sampleRate: Int = 16_000, channels: Int = 1) {
    if (pcmEnabled && state == SourceState.LIVE) {
      pcmListener?.onPcm(pcm, sampleRate, channels)
    }
  }
}

class GlassesMediaSourceContractTest {
  private fun contract(source: FakeGlassesMediaSource) {
    val pcm = mutableListOf<ByteArray>()
    source.pcmListener = PcmListener { bytes, _, _ -> pcm.add(bytes) }
    val controller = GlassesMediaController { _, listener ->
      source.pcmListener = listener
      source
    }

    assertThat(controller.state).isEqualTo(SourceState.IDLE)
    controller.attach(
      video = VideoFrameListener { _ -> },
      pcm = { bytes, _, _ -> pcm.add(bytes) },
      config = SourceConfig("https://example.com/whep"),
    )
    assertThat(source.started).containsExactly(SourceConfig("https://example.com/whep"))
    assertThat(controller.state).isEqualTo(SourceState.LIVE)

    source.emitPcm(byteArrayOf(1, 2, 3, 4))
    assertThat(pcm).hasSize(1)

    controller.setPcmDeliveryEnabled(false)
    source.emitPcm(byteArrayOf(9, 9))
    assertThat(pcm).hasSize(1)

    controller.restart(SourceConfig("https://example.com/whep-2"))
    assertThat(source.restarted.map { it.url }).contains("https://example.com/whep-2")
    assertThat(controller.state).isEqualTo(SourceState.LIVE)

    controller.setTargetSize(TargetSize(1280, 720))
    assertThat(source.targetSizes).contains(TargetSize(1280, 720))

    controller.stop()
    assertThat(source.stopped).isGreaterThanOrEqualTo(1)
    assertThat(controller.state).isEqualTo(SourceState.IDLE)
  }

  @Test
  fun fakeSourceHonorsStartRestartStopPcmAndState() {
    contract(FakeGlassesMediaSource())
  }

  @Test
  fun sameUrlIsReusedUntilTheSubscriberFails() {
    val url = "https://example.com/whep"
    val config = SourceConfig(url)
    // A resumed glasses uplink re-sends the same URL. ACS never lost its
    // subscription, so rebuilding would only restart the wait for a first frame.
    assertThat(canReuseSource(url, SourceState.LIVE, config)).isTrue()
    // Includes the answer → first frame window, which LIVE no longer covers.
    assertThat(canReuseSource(url, SourceState.CONNECTING, config)).isTrue()
    // ICE dropped, or the answer never produced a frame: rebuild.
    assertThat(canReuseSource(url, SourceState.FAILED, config)).isFalse()
    // A new stream means a new WHEP URL, and a stopped source has none.
    assertThat(canReuseSource(url, SourceState.LIVE, SourceConfig("https://example.com/whep-2"))).isFalse()
    assertThat(canReuseSource(null, SourceState.IDLE, config)).isFalse()
    assertThat(canReuseSource(url, SourceState.LIVE, SourceConfig(url, SourceKind.DIRECT))).isFalse()
  }

  @Test
  fun softApIsNeverReusedBecauseTheListenerBelongsToOneAttempt() {
    // A SoftAP attempt owns a listener, a port and a peer. There is no URL to keep across a
    // rebuild — the URL is an output of binding, not an input — so reuse must always be refused,
    // even when the config and state would otherwise look reusable.
    val config = SourceConfig("", SourceKind.SOFTAP, bindAddress = "192.168.43.20")

    assertThat(canReuseSource("", SourceState.LIVE, config)).isFalse()
    assertThat(canReuseSource("", SourceState.CONNECTING, config)).isFalse()
  }

  @Test
  fun onlySoftApReportsAnIngestUrl() {
    // Every other kind is told its URL, so exposing one would be a contract error waiting to be
    // read by the orchestrator that hands the URL to the glasses.
    assertThat(FakeGlassesMediaSource().ingestUrl).isNull()
  }

  @Test
  fun syntheticSourceHonorsStartRestartStopAndState() {
    val source = SyntheticI420Source(
      video = { _ -> },
      stats = com.mentra.acsmeeting.telemetry.PipelineStats(),
      isReady = { false },
    )
    val controller = GlassesMediaController { _, _ -> source }

    assertThat(controller.state).isEqualTo(SourceState.IDLE)
    controller.attach(
      video = { _ -> },
      pcm = { _, _, _ -> },
      config = SourceConfig("https://example.com/whep", SourceKind.DIRECT),
    )
    assertThat(controller.state).isEqualTo(SourceState.LIVE)

    controller.setPcmDeliveryEnabled(false)
    assertThat(source.pcmDeliveryEnabled()).isFalse()

    controller.restart(SourceConfig("https://example.com/whep-2", SourceKind.DIRECT))
    assertThat(controller.state).isEqualTo(SourceState.LIVE)

    controller.setTargetSize(TargetSize(1280, 720))
    controller.stop()
    assertThat(controller.state).isEqualTo(SourceState.IDLE)
  }
}
