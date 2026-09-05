package com.mentra.acsmeeting.source

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

/**
 * Covers the scale decision the relay makes on every frame.
 *
 * This code was previously inline in [CloudflareWhepSource] with no coverage at all, and it is
 * decided per frame on the decode thread. Both directions are invisible when wrong: an unnecessary
 * scale is a silent per-frame CPU cost, and a skipped one is a plane-size mismatch at the ACS
 * sender rather than an exception here.
 */
class DecodedTrackRelayTest {

  @Test
  fun `no target size means ACS has not negotiated yet, so the buffer passes through`() {
    assertThat(DecodedTrackRelay.needsScale(null, 1280, 720)).isFalse()
  }

  @Test
  fun `a target matching the buffer needs no scale`() {
    assertThat(DecodedTrackRelay.needsScale(TargetSize(1280, 720), 1280, 720)).isFalse()
  }

  @Test
  fun `a differing width or height needs a scale`() {
    assertThat(DecodedTrackRelay.needsScale(TargetSize(640, 720), 1280, 720)).isTrue()
    assertThat(DecodedTrackRelay.needsScale(TargetSize(1280, 360), 1280, 720)).isTrue()
    assertThat(DecodedTrackRelay.needsScale(TargetSize(640, 360), 1280, 720)).isTrue()
  }

  /**
   * A transposed target is a real size change, not a rotation to be ignored. The relay works in
   * unrotated buffer coordinates, so 720x1280 against a 1280x720 buffer must scale.
   */
  @Test
  fun `a transposed target still needs a scale`() {
    assertThat(DecodedTrackRelay.needsScale(TargetSize(720, 1280), 1280, 720)).isTrue()
  }
}
