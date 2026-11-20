package com.mentra.glassesmedia.source

import java.nio.ByteBuffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DecodedFrameTapTest {
  private val ACS = DecodedFrameProducer.ACS
  private val RELAY = DecodedFrameProducer.RELAY

  private fun planes(): I420Planes {
    val y = ByteBuffer.allocate(16)
    val c = ByteBuffer.allocate(4)
    return I420Planes(y, 4, c, 2, c.duplicate(), 2, 4, 4, 0L)
  }

  @After
  fun tearDown() {
    DecodedFrameTap.setTelemetryEnabled(false)
    DecodedFrameTap.detach(DecodedFrameTap.attach({}, ACS))
    DecodedFrameTap.drainMetrics()
  }

  @Test
  fun noSinkAndTelemetryOffCollectsNothing() {
    DecodedFrameTap.drainMetrics()
    repeat(5) { DecodedFrameTap.offer(planes(), ACS) }
    DecodedFrameTap.recordAcsSend()
    val metrics = DecodedFrameTap.drainMetrics()
    assertEquals(0L, metrics.framesOffered)
    assertEquals(0L, metrics.acsFramesSent)
  }

  @Test
  fun telemetryCollectsCadenceAndSendsWithNoSink() {
    DecodedFrameTap.setTelemetryEnabled(true)
    DecodedFrameTap.drainMetrics()
    repeat(5) {
      DecodedFrameTap.offer(planes(), ACS)
      DecodedFrameTap.recordAcsSend()
    }
    val metrics = DecodedFrameTap.drainMetrics()
    assertEquals(5L, metrics.framesOffered)
    assertEquals(0L, metrics.framesWithSink)
    assertEquals(4L, metrics.cadenceSamples)
    assertEquals(5L, metrics.acsFramesSent)
  }

  @Test
  fun aThrowingSinkNeverReachesTheCallerAndIsReported() {
    var reported: Throwable? = null
    val generation = DecodedFrameTap.attach({ throw IllegalStateException("boom") }, ACS) { reported = it }
    DecodedFrameTap.drainMetrics()
    DecodedFrameTap.offer(planes(), ACS)
    DecodedFrameTap.offer(planes(), ACS)
    val metrics = DecodedFrameTap.drainMetrics()
    assertEquals(2L, metrics.sinkExceptions)
    assertEquals(2L, metrics.framesWithSink)
    assertTrue(reported is IllegalStateException)
    DecodedFrameTap.detach(generation)
  }

  @Test
  fun aThrowingErrorHandlerIsContainedToo() {
    val generation = DecodedFrameTap.attach({ throw IllegalStateException("sink") }, ACS) { throw IllegalStateException("handler") }
    DecodedFrameTap.offer(planes(), ACS)
    DecodedFrameTap.detach(generation)
  }

  @Test
  fun aSinkThrowableThatCannotBeRenderedIsContained() {
    val unrenderable = object : RuntimeException() {
      override val message: String get() = throw IllegalStateException("message")
      override fun toString(): String = throw IllegalStateException("toString")
    }
    var reported: Throwable? = null
    val generation = DecodedFrameTap.attach({ throw unrenderable }, ACS) { reported = it }
    DecodedFrameTap.drainMetrics()
    DecodedFrameTap.offer(planes(), ACS)
    assertEquals(1L, DecodedFrameTap.drainMetrics().sinkExceptions)
    assertTrue(reported === unrenderable)
    DecodedFrameTap.detach(generation)
  }

  @Test
  fun aLateDetachCannotRemoveANewerSink() {
    var newerFrames = 0
    val older = DecodedFrameTap.attach({}, ACS)
    val newer = DecodedFrameTap.attach({ newerFrames += 1 }, ACS)
    assertFalse(DecodedFrameTap.detach(older))
    assertFalse(DecodedFrameTap.isCurrent(older))
    assertTrue(DecodedFrameTap.isCurrent(newer))
    DecodedFrameTap.offer(planes(), ACS)
    assertEquals(1, newerFrames)
    assertTrue(DecodedFrameTap.detach(newer))
    assertFalse(DecodedFrameTap.hasSink())
  }

  @Test
  fun aSinkOnlyReceivesFramesFromItsOwnProducer() {
    var acsFrames = 0
    val acs = DecodedFrameTap.attach({ acsFrames += 1 }, ACS)
    DecodedFrameTap.offer(planes(), ACS)
    DecodedFrameTap.offer(planes(), RELAY)
    DecodedFrameTap.offer(planes(), ACS)
    assertEquals(2, acsFrames)
    assertTrue(DecodedFrameTap.detach(acs))

    var relayFrames = 0
    val relay = DecodedFrameTap.attach({ relayFrames += 1 }, RELAY)
    DecodedFrameTap.offer(planes(), ACS)
    DecodedFrameTap.offer(planes(), RELAY)
    assertEquals(1, relayFrames)
    assertEquals(2, acsFrames)
    assertTrue(DecodedFrameTap.detach(relay))
  }

  /**
   * Teams with Direct link off runs both decoders at once. The relay's copy must not double the
   * frame count the ACS preview reports.
   */
  @Test
  fun framesFromTheOtherProducerAreNotCounted() {
    val generation = DecodedFrameTap.attach({}, ACS)
    DecodedFrameTap.drainMetrics()
    repeat(4) {
      DecodedFrameTap.offer(planes(), ACS)
      DecodedFrameTap.offer(planes(), RELAY)
    }
    val metrics = DecodedFrameTap.drainMetrics()
    assertEquals(4L, metrics.framesOffered)
    assertEquals(4L, metrics.framesWithSink)
    assertEquals(3L, metrics.cadenceSamples)
    assertTrue(DecodedFrameTap.detach(generation))
  }

  @Test
  fun aThrowingSinkIsNotCalledForTheOtherProducer() {
    var reported = 0
    val generation = DecodedFrameTap.attach({ throw IllegalStateException("boom") }, RELAY) { reported += 1 }
    DecodedFrameTap.drainMetrics()
    DecodedFrameTap.offer(planes(), ACS)
    assertEquals(0, reported)
    assertEquals(0L, DecodedFrameTap.drainMetrics().sinkExceptions)
    DecodedFrameTap.offer(planes(), RELAY)
    assertEquals(1, reported)
    assertTrue(DecodedFrameTap.detach(generation))
  }

  @Test
  fun telemetryWithNoSinkMeasuresTheAcsCallOnly() {
    DecodedFrameTap.setTelemetryEnabled(true)
    DecodedFrameTap.drainMetrics()
    DecodedFrameTap.offer(planes(), RELAY)
    DecodedFrameTap.offer(planes(), ACS)
    assertEquals(1L, DecodedFrameTap.drainMetrics().framesOffered)

    // A relay sink that has gone leaves telemetry measuring the ACS call again.
    assertTrue(DecodedFrameTap.detach(DecodedFrameTap.attach({}, RELAY)))
    DecodedFrameTap.offer(planes(), RELAY)
    DecodedFrameTap.offer(planes(), ACS)
    assertEquals(1L, DecodedFrameTap.drainMetrics().framesOffered)
  }

  @Test
  fun reattachingForAnotherProducerSwitchesWhatIsDelivered() {
    var acsFrames = 0
    var relayFrames = 0
    val first = DecodedFrameTap.attach({ acsFrames += 1 }, ACS)
    val second = DecodedFrameTap.attach({ relayFrames += 1 }, RELAY)
    DecodedFrameTap.offer(planes(), ACS)
    DecodedFrameTap.offer(planes(), RELAY)
    assertEquals(0, acsFrames)
    assertEquals(1, relayFrames)
    assertFalse(DecodedFrameTap.detach(first))
    assertTrue(DecodedFrameTap.detach(second))
  }
}
