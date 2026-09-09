package com.mentra.acsmeeting.telemetry

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class RingPercentileTest {
  @Test
  fun emptyIsNa() {
    assertThat(RingPercentile().p50()).isEqualTo("na")
    assertThat(RingPercentile().p95()).isEqualTo("na")
  }

  @Test
  fun knownInputs() {
    val ring = RingPercentile(8)
    ring.record(10_000_000)
    ring.record(20_000_000)
    ring.record(40_000_000)
    assertThat(ring.p50()).isEqualTo("20.0")
  }

  @Test
  fun wraparoundKeepsNewest() {
    val ring = RingPercentile(3)
    repeat(6) { index -> ring.record((index + 1) * 1_000_000L) }
    assertThat(ring.size()).isEqualTo(3)
    assertThat(ring.p50()).isEqualTo("5.0")
  }

  @Test
  fun concurrentRecordDoesNotCorruptCount() {
    val ring = RingPercentile(32)
    val pool = Executors.newFixedThreadPool(4)
    val latch = CountDownLatch(4)
    repeat(4) {
      pool.execute {
        repeat(50) { ring.record(1_000_000) }
        latch.countDown()
      }
    }
    assertThat(latch.await(5, TimeUnit.SECONDS)).isTrue()
    pool.shutdown()
    assertThat(ring.size()).isEqualTo(32)
    assertThat(ring.p50()).isNotEqualTo("na")
  }
}
