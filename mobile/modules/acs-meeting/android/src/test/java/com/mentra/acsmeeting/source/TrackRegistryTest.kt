package com.mentra.acsmeeting.source

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class TrackRegistryTest {
  @Test
  fun threeClaimsOfOneIdYieldTrueFalseFalse() {
    val registry = TrackRegistry()
    assertThat(registry.claim("track-a")).isTrue()
    assertThat(registry.claim("track-a")).isFalse()
    assertThat(registry.claim("track-a")).isFalse()
    assertThat(registry.size()).isEqualTo(1)
    assertThat(registry.skipped()).isEqualTo(2)
  }

  @Test
  fun distinctIdsEachClaimOnce() {
    val registry = TrackRegistry()
    assertThat(registry.claim("video")).isTrue()
    assertThat(registry.claim("audio")).isTrue()
    assertThat(registry.size()).isEqualTo(2)
    assertThat(registry.skipped()).isEqualTo(0)
  }

  @Test
  fun resetMakesTheSameIdClaimableAgain() {
    val registry = TrackRegistry()
    assertThat(registry.claim("track-a")).isTrue()
    registry.reset()
    assertThat(registry.size()).isEqualTo(0)
    assertThat(registry.skipped()).isEqualTo(0)
    assertThat(registry.claim("track-a")).isTrue()
    assertThat(registry.size()).isEqualTo(1)
  }
}
