package com.mentra.framepreview

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.within
import org.junit.Test

class PreviewPercentileRingTest {
  @Test
  fun `reports percentiles and a maximum over a small sample`() {
    val ring = PreviewPercentileRing(capacity = 8)
    for (value in 1..8) ring.record(value * 1_000_000L)
    assertThat(ring.sampleCount()).isEqualTo(8)
    assertThat(ring.percentileMs(0.50)).isCloseTo(5.0, within(0.001))
    assertThat(ring.percentileMs(0.95)).isCloseTo(8.0, within(0.001))
    assertThat(ring.percentileMs(0.99)).isCloseTo(8.0, within(0.001))
    assertThat(ring.maxMs()).isCloseTo(8.0, within(0.001))
  }

  /**
   * The reason the ring exists: a soak must not grow memory. The reason the maximum is not
   * windowed is here too — the worst frame of the run is the one that was visible, and a lapped
   * ring would have forgotten it.
   */
  @Test
  fun `the ring laps but the maximum survives`() {
    val ring = PreviewPercentileRing(capacity = 4)
    ring.record(500_000_000)
    repeat(8) { ring.record(1_000_000) }
    assertThat(ring.sampleCount()).isEqualTo(4)
    assertThat(ring.percentileMs(0.95)).isCloseTo(1.0, within(0.001))
    assertThat(ring.maxMs()).isCloseTo(500.0, within(0.001))

    ring.reset()
    assertThat(ring.maxMs()).isEqualTo(0.0)
    assertThat(ring.percentileMs(0.50)).isEqualTo(0.0)
  }

  @Test
  fun `an empty ring reports zero rather than throwing`() {
    val ring = PreviewPercentileRing(capacity = 4)
    assertThat(ring.percentileMs(0.50)).isEqualTo(0.0)
    assertThat(ring.maxMs()).isEqualTo(0.0)
  }
}

class PreviewStatsTest {
  @Test
  fun `delivery gaps measure cadence rather than rate`() {
    val stats = PreviewStats()
    stats.onRunStart(0)
    // 30 ms, 100 ms, 30 ms: a mean fps that looks healthy over a lumpy cadence.
    stats.onDelivered(10, 0)
    stats.onDelivered(10, 30_000_000)
    stats.onDelivered(10, 130_000_000)
    stats.onDelivered(10, 160_000_000)
    assertThat(stats.delivered).isEqualTo(4)
    // Three deliveries after the first, so three gaps: the first frame has nothing to compare to.
    assertThat(stats.deliveryGap.sampleCount()).isEqualTo(3)
    assertThat(stats.deliveryGap.percentileMs(0.50)).isCloseTo(30.0, within(0.001))
    assertThat(stats.deliveryGap.maxMs()).isCloseTo(100.0, within(0.001))
  }

  @Test
  fun `first frame latencies are measured from the start of the run and never overwritten`() {
    val stats = PreviewStats()
    stats.onRunStart(1_000_000_000)
    stats.onDelivered(10, 1_250_000_000)
    stats.onAckAccepted(5_000_000, 1_300_000_000)
    assertThat(stats.firstDeliveredLatencyMs).isCloseTo(250.0, within(0.001))
    assertThat(stats.firstAckLatencyMs).isCloseTo(300.0, within(0.001))

    stats.onDelivered(10, 9_000_000_000)
    stats.onAckAccepted(5_000_000, 9_000_000_000)
    assertThat(stats.firstDeliveredLatencyMs).isCloseTo(250.0, within(0.001))
    assertThat(stats.firstAckLatencyMs).isCloseTo(300.0, within(0.001))
  }

  @Test
  fun `skip reasons are counted apart from each other`() {
    val stats = PreviewStats()
    stats.onSkippedPacing()
    stats.onSkippedBusy()
    stats.onPreDispatchDrop()
    stats.onSlotStarved()
    assertThat(stats.skippedPacing).isEqualTo(1)
    assertThat(stats.skippedBusy).isEqualTo(1)
    assertThat(stats.preDispatchDrops).isEqualTo(1)
    assertThat(stats.slotStarved).isEqualTo(1)
  }

  /**
   * A stop/start must not average the new run's first second over however long the preview sat
   * idle, which is what a window that only restarts on `takeWindow` would do.
   */
  @Test
  fun `a new run restarts the rate window`() {
    val stats = PreviewStats()
    stats.onRunStart(0)
    stats.takeWindow(1_000_000_000)

    stats.onRunStart(11_000_000_000)
    stats.onDelivered(10, 11_500_000_000)
    val window = stats.takeWindow(12_000_000_000)
    assertThat(window.deliveredFps).isCloseTo(1.0, within(0.001))
  }

  @Test
  fun `the rate window is zero until time has passed and then reports per second`() {
    val stats = PreviewStats()
    stats.onRunStart(0)
    // No elapsed time to divide by, so the honest answer is zero rather than a division by zero.
    assertThat(stats.takeWindow(0).deliveredFps).isEqualTo(0.0)

    stats.onSourceFrame()
    stats.onSourceFrame()
    stats.onDelivered(1000, 500_000_000)
    val window = stats.takeWindow(1_000_000_000)
    assertThat(window.sourceFps).isCloseTo(2.0, within(0.001))
    assertThat(window.deliveredFps).isCloseTo(1.0, within(0.001))
    assertThat(window.bytesPerSecond).isCloseTo(1000.0, within(0.001))
  }

  @Test
  fun `reset clears counters rings and the first frame latencies`() {
    val stats = PreviewStats()
    stats.onRunStart(0)
    stats.onSourceFrame()
    stats.onDelivered(100, 10_000_000)
    stats.onDelivered(100, 40_000_000)
    stats.pack.record(5_000_000)

    stats.reset(0)
    assertThat(stats.sourceFrames).isEqualTo(0)
    assertThat(stats.delivered).isEqualTo(0)
    assertThat(stats.payloadBytes).isEqualTo(0)
    assertThat(stats.firstDeliveredLatencyMs).isEqualTo(0.0)
    assertThat(stats.pack.maxMs()).isEqualTo(0.0)
    assertThat(stats.deliveryGap.sampleCount()).isEqualTo(0)
  }
}
