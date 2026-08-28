package com.mentra.acsmeeting

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test
import java.nio.ByteBuffer

class FakeGlassesMediaSource : GlassesMediaSource {
  val started = mutableListOf<SourceConfig>()
  val restarted = mutableListOf<SourceConfig>()
  var stopped = 0
  var pcmEnabled = true
  var pcmListener: PcmListener? = null
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
      video = VideoFrameListener { _: ByteBuffer, _: Int, _: Int, _: Long -> },
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

    controller.stop()
    assertThat(source.stopped).isGreaterThanOrEqualTo(1)
    assertThat(controller.state).isEqualTo(SourceState.IDLE)
  }

  @Test
  fun fakeSourceHonorsStartRestartStopPcmAndState() {
    contract(FakeGlassesMediaSource())
  }
}

class CapturePolicyTest {
  @Test
  fun glassesCapturesMicAndPhoneDoesNot() {
    assertThat(CapturePolicy.captureGlassesMic(AudioSourceKind.GLASSES)).isTrue()
    assertThat(CapturePolicy.captureGlassesMic(AudioSourceKind.PHONE)).isFalse()
  }
}
