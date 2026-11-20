package com.mentra.glassesmedia.source

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class IceDisconnectGraceTest {
  private val scheduled = mutableListOf<Pair<Runnable, Long>>()
  private var expired = 0
  private val grace = IceDisconnectGrace(
    graceMs = 10_000,
    schedule = { task, delay -> scheduled += task to delay },
    cancelScheduled = { task -> scheduled.removeAll { it.first === task } },
    onExpired = { expired++ },
  )

  @Test
  fun `a disconnect does not fail until the grace period runs out`() {
    grace.onDisconnected()
    assertThat(expired).isEqualTo(0)
    assertThat(grace.isWaiting).isTrue()
    assertThat(scheduled.single().second).isEqualTo(10_000)
    scheduled.single().first.run()
    assertThat(expired).isEqualTo(1)
    assertThat(grace.isWaiting).isFalse()
  }

  @Test
  fun `a recovery inside the grace period cancels the failure`() {
    grace.onDisconnected()
    grace.clear()
    assertThat(scheduled).isEmpty()
    assertThat(expired).isEqualTo(0)
  }

  @Test
  fun `a repeated disconnect does not restart the clock`() {
    grace.onDisconnected()
    grace.onDisconnected()
    assertThat(scheduled).hasSize(1)
  }

  @Test
  fun `a deadline that was cleared and fires late is ignored`() {
    grace.onDisconnected()
    val stale = scheduled.single().first
    grace.clear()
    stale.run()
    assertThat(expired).isEqualTo(0)
  }

  @Test
  fun `a second disconnect after a recovery gets a fresh period`() {
    grace.onDisconnected()
    grace.clear()
    grace.onDisconnected()
    scheduled.single().first.run()
    assertThat(expired).isEqualTo(1)
  }
}
