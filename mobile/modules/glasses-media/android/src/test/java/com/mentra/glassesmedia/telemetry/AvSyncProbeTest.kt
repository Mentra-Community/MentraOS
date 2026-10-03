package com.mentra.glassesmedia.telemetry

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class AvSyncProbeTest {
  @Test
  fun clapInFrameReportsAudioLead() {
    val lines = mutableListOf<String>()
    val probe = AvSyncProbe(log = { lines.add(it) })

    probe.onAudioLevel(200, 1_000_000_000L)
    probe.onVideoLuma(80, 1_000_000_000L)
    probe.onAudioLevel(4_200, 1_010_000_000L)
    probe.onVideoLuma(96, 1_190_000_000L)

    assertThat(probe.lastAudioLeadMs()).isEqualTo(180)
    assertThat(probe.clapCount()).isEqualTo(1)
    assertThat(lines.single()).isEqualTo("AVSYNC clap audioLeadMs=180 meanAbs=4200 lumaY=96 clapN=1")
  }

  @Test
  fun videoFirstReportsNegativeLead() {
    val probe = AvSyncProbe(log = {})
    probe.onAudioLevel(100, 0L)
    probe.onVideoLuma(70, 0L)
    probe.onVideoLuma(90, 20_000_000L)
    probe.onAudioLevel(5_000, 100_000_000L)

    assertThat(probe.lastAudioLeadMs()).isEqualTo(-80)
  }

  @Test
  fun lumaJumpAloneIsNotAClap() {
    val lines = mutableListOf<String>()
    val probe = AvSyncProbe(log = { lines.add(it) })
    probe.onVideoLuma(80, 0L)
    probe.onVideoLuma(120, 16_000_000L)

    assertThat(probe.lastAudioLeadMs()).isNull()
    assertThat(lines).isEmpty()
  }

  @Test
  fun audioSpikeAloneExpiresWithoutAMatch() {
    val lines = mutableListOf<String>()
    val probe = AvSyncProbe(log = { lines.add(it) })
    probe.onAudioLevel(100, 0L)
    probe.onAudioLevel(5_000, 20_000_000L)
    probe.onVideoLuma(80, 20_000_000L + AvSyncProbe.MATCH_WINDOW_NS + 1)

    assertThat(probe.lastAudioLeadMs()).isNull()
    assertThat(lines).isEmpty()
  }

  @Test
  fun cooldownIgnoresTheRingOfOneClap() {
    val probe = AvSyncProbe(log = {})
    probe.onAudioLevel(100, 0L)
    probe.onVideoLuma(80, 0L)
    probe.onAudioLevel(4_000, 20_000_000L)
    probe.onVideoLuma(100, 40_000_000L)
    probe.onAudioLevel(200, 50_000_000L)
    probe.onAudioLevel(6_000, 60_000_000L)
    probe.onVideoLuma(80, 80_000_000L)

    assertThat(probe.clapCount()).isEqualTo(1)
    assertThat(probe.lastAudioLeadMs()).isEqualTo(20)
  }

  @Test
  fun tickPrintsNaUntilAClap() {
    val probe = AvSyncProbe(log = {})
    assertThat(probe.tick(videoE2eP50 = "240.0", videoAgeP50 = "180.0"))
      .isEqualTo("AVSYNC live videoE2eP50=240.0 videoAgeP50=180.0 lastClapLeadMs=na clapN=0 meanAbs=-1 lumaY=-1")
  }

  @Test
  fun meanAbs16MatchesAKnownBuffer() {
    val pcm = byteArrayOf(0x00, 0x10, 0x00, 0x00)
    assertThat(AvSyncProbe.meanAbs16(pcm)).isEqualTo(2048)
  }
}
