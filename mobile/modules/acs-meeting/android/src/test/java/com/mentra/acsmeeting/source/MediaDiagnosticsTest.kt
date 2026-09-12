package com.mentra.glassesmedia.source

import com.mentra.acsmeeting.audio.AudioUplinkChain
import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class MediaDiagnosticsTest {
  @Test
  fun videoArmDefaultsToWhep() {
    assertThat(MediaDiagnostics.videoArm).isEqualTo(VideoSourceArm.WHEP)
  }

  @Test
  fun decoderModeDefaultsToTexture() {
    assertThat(MediaDiagnostics.decoderMode).isEqualTo(DecoderMode.TEXTURE)
  }

  @Test
  fun zeroCopyDefaultsToOff() {
    assertThat(MediaDiagnostics.zeroCopy).isFalse()
  }

  @Test
  fun pixelFormatDefaultsToI420() {
    assertThat(MediaDiagnostics.pixelFormat).isEqualTo(PixelFormatArm.I420)
  }

  /**
   * The blind clamp is off, so ACS is told the rate Mentra Call actually asked
   * for. It was justified by soaks that read ~8.8 fps at both 720p and 540p —
   * a ceiling that does not move with pixel count, measured through a send path
   * that could not hold a rate. Restore it only for a fixed-rate A/B, and only
   * with a `P7 rate bound=ENCODER_SHORT` line to point at.
   */
  @Test
  fun outgoingRateAdvertisesWhatWasRequested() {
    assertThat(MediaDiagnostics.outgoingRate).isEqualTo(OutgoingRateArm.ADVERTISE_REQUESTED)
  }

  /**
   * A/V alignment ships uncorrected until a receiver recording says what to correct by.
   *
   * A non-zero default here would be a guess wearing the clothes of a measurement, and the obvious
   * way to derive one — comparing first-audio to first-video arrival — measures how long the camera
   * took to boot, not how far apart the two streams play out.
   */
  @Test
  fun audioDelayShipsAtZeroUntilItIsMeasured() {
    assertThat(MediaDiagnostics.acsAudioDelayMs).isEqualTo(0)
  }

  @Test
  fun theConfiguredDelayStaysInsideTheChainsCeiling() {
    assertThat(MediaDiagnostics.acsAudioDelayMs).isBetween(0, AudioUplinkChain.MAX_DELAY_MS)
  }

  /**
   * The two knobs the receiver-side measurement needs. Timestamps on/off and delay zero/non-zero
   * are what make the four configurations — neither, either, both — selectable on one device; a
   * hardcoded `true` would leave half the matrix unreachable and the question unanswered.
   */
  @Test
  fun timestampsDefaultOnAndRemainSwitchable() {
    assertThat(MediaDiagnostics.acsAudioTimestamps).isTrue()
  }
}
