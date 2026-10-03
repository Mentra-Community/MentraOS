package com.mentra.acsmeeting.telemetry

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The state machine that decides an episode happened. Tested hard because it is the thing that
 * turns a device session into a verdict, and its two failure modes are both silent: inventing
 * episodes out of ACS's empty reports, or missing a real one and pronouncing a bad call healthy.
 */
class WireEpisodeTrackerTest {

  private fun tracker() = WireEpisodeTracker()

  private fun WireEpisodeTracker.feed(
    atMs: Long,
    bitrateBps: Long?,
    width: Int? = 960,
    height: Int? = 540,
    inbound: Double? = 2_000_000.0,
    sentFps: Double = 15.0,
  ) = observe(atMs, bitrateBps, width, height, inbound, sentFps)

  @Test
  fun `a healthy wire produces no events at all`() {
    val tracker = tracker()

    for (t in 0..10) {
      assertNull(tracker.feed(t * 2_000L, 1_300_000))
    }
    assertFalse(tracker.isInEpisode())
    assertFalse(tracker.isAwaitingRecovery())
  }

  /**
   * The capture that motivated the class: a dip that ends long before the picture comes back.
   * Reporting only the dip would understate what the wearer sat through by more than half.
   */
  @Test
  fun `a dip and its climb are reported as separate costs`() {
    val tracker = tracker()

    assertNull(tracker.feed(0, 1_300_000))
    val begin = tracker.feed(150_000, 33_000, width = 320, height = 180)
    assertNotNull(begin)
    assertEquals(WireEpisodeTracker.Phase.BEGIN, begin!!.phase)
    assertEquals(150_000L, begin.startedAtMs)
    assertEquals(0L, begin.durationMs)
    // Not yet recovered, and -1 says so rather than claiming an instant recovery.
    assertEquals(-1L, begin.recoveryMs)
    assertTrue(tracker.isInEpisode())

    assertNull(tracker.feed(200_000, 40_000, width = 320, height = 180))

    val end = tracker.feed(240_000, 700_000, width = 640, height = 360)
    assertNotNull(end)
    assertEquals(WireEpisodeTracker.Phase.END, end!!.phase)
    assertEquals(90_000L, end.durationMs)
    assertEquals(33_000L, end.minBitrateBps)
    assertEquals("320x180", end.minResolution)
    assertEquals(-1L, end.recoveryMs)
    assertFalse(tracker.isInEpisode())
    assertTrue(tracker.isAwaitingRecovery())

    // Still under 1 Mbps: degraded, so not recovered.
    assertNull(tracker.feed(300_000, 900_000))

    val recovered = tracker.feed(410_000, 1_300_000)
    assertNotNull(recovered)
    assertEquals(WireEpisodeTracker.Phase.RECOVERED, recovered!!.phase)
    assertEquals(90_000L, recovered.durationMs)
    assertEquals(170_000L, recovered.recoveryMs)
    assertFalse(tracker.isAwaitingRecovery())
  }

  /**
   * The rule that keeps the whole thing honest. ACS has been observed publishing 32 empty
   * MEDIA_STATISTICS reports against 12 filled ones on one seven-minute call; if an unset field
   * counted as zero, that call would report 32 episodes and the real ones would be unfindable.
   */
  @Test
  fun `an unreported rate is not an episode`() {
    val tracker = tracker()

    assertNull(tracker.feed(0, 1_300_000))
    assertNull(tracker.feed(2_000, null))
    assertNull(tracker.feed(4_000, -1))
    assertNull(tracker.feed(6_000, 0))

    assertFalse(tracker.isInEpisode())
    // And the healthy state survived the silence rather than being reset by it.
    assertNull(tracker.feed(8_000, 1_300_000))
  }

  /** Silence in the middle of an episode must not end it either. */
  @Test
  fun `silence during an episode leaves it open`() {
    val tracker = tracker()

    assertNotNull(tracker.feed(0, 40_000))
    assertNull(tracker.feed(2_000, null))
    assertTrue(tracker.isInEpisode())

    val end = tracker.feed(10_000, 1_300_000)
    assertEquals(WireEpisodeTracker.Phase.END, end!!.phase)
    assertEquals(10_000L, end.durationMs)
  }

  /**
   * Two dips with a brief good patch between them are two episodes. Merging them would hide the
   * flapping, which is a different fault from one long collapse and points somewhere else.
   */
  @Test
  fun `a second dip before recovery starts a new episode`() {
    val tracker = tracker()

    assertNotNull(tracker.feed(0, 40_000))
    val firstEnd = tracker.feed(10_000, 600_000)
    assertEquals(WireEpisodeTracker.Phase.END, firstEnd!!.phase)

    val secondBegin = tracker.feed(20_000, 35_000)
    assertNotNull(secondBegin)
    assertEquals(WireEpisodeTracker.Phase.BEGIN, secondBegin!!.phase)
    assertEquals(20_000L, secondBegin.startedAtMs)
    // The new episode starts clean rather than inheriting the first one's floor.
    assertEquals(35_000L, secondBegin.minBitrateBps)
  }

  @Test
  fun `the glasses hop during the episode is averaged and carried`() {
    val tracker = tracker()

    tracker.feed(0, 40_000, inbound = 2_000_000.0)
    tracker.feed(2_000, 35_000, inbound = 2_200_000.0)
    val end = tracker.feed(4_000, 1_300_000, inbound = 2_100_000.0)

    // ~2.1 Mbps from the source while the wire sat at 35 kbps. This is the number that says the
    // collapse was ACS's choice and not a starved pipeline.
    assertEquals(2_100_000.0, end!!.inboundBitrateBps!!, 1.0)
  }

  @Test
  fun `an episode with no glasses reading reports none rather than zero`() {
    val tracker = tracker()

    tracker.feed(0, 40_000, inbound = null)
    val end = tracker.feed(2_000, 1_300_000, inbound = null)

    assertNull(end!!.inboundBitrateBps)
  }

  @Test
  fun `an episode with no size reading still reports its floor`() {
    val tracker = tracker()

    tracker.feed(0, 40_000, width = null, height = null)
    val end = tracker.feed(2_000, 1_300_000)

    assertEquals(40_000L, end!!.minBitrateBps)
    assertEquals("", end.minResolution)
  }

  /** A jump straight from the floor past the recovery line reports one event, then the other. */
  @Test
  fun `a straight jump to full rate reports end then recovered`() {
    val tracker = tracker()

    tracker.feed(0, 40_000)
    val end = tracker.feed(2_000, 1_300_000)
    assertEquals(WireEpisodeTracker.Phase.END, end!!.phase)

    val recovered = tracker.feed(4_000, 1_300_000)
    assertEquals(WireEpisodeTracker.Phase.RECOVERED, recovered!!.phase)
    assertEquals(2_000L, recovered.recoveryMs)
  }
}
