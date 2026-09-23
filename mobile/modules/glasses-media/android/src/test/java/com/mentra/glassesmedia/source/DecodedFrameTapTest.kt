package com.mentra.glassesmedia.source

import java.nio.ByteBuffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DecodedFrameTapTest {
  private fun planes(): I420Planes {
    val y = ByteBuffer.allocate(16)
    val c = ByteBuffer.allocate(4)
    return I420Planes(y, 4, c, 2, c.duplicate(), 2, 4, 4, 0L)
  }

  @After
  fun tearDown() {
    DecodedFrameTap.setTelemetryEnabled(false)
    DecodedFrameTap.detach(DecodedFrameTap.attach({}))
    DecodedFrameTap.drainMetrics()
  }

  @Test
  fun noSinkAndTelemetryOffCollectsNothing() {
    DecodedFrameTap.drainMetrics()
    repeat(5) { DecodedFrameTap.offer(planes()) }
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
      DecodedFrameTap.offer(planes())
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
    val generation = DecodedFrameTap.attach({ throw IllegalStateException("boom") }) { reported = it }
    DecodedFrameTap.drainMetrics()
    DecodedFrameTap.offer(planes())
    DecodedFrameTap.offer(planes())
    val metrics = DecodedFrameTap.drainMetrics()
    assertEquals(2L, metrics.sinkExceptions)
    assertEquals(2L, metrics.framesWithSink)
    assertTrue(reported is IllegalStateException)
    DecodedFrameTap.detach(generation)
  }

  @Test
  fun aThrowingErrorHandlerIsContainedToo() {
    val generation = DecodedFrameTap.attach({ throw IllegalStateException("sink") }) { throw IllegalStateException("handler") }
    DecodedFrameTap.offer(planes())
    DecodedFrameTap.detach(generation)
  }

  @Test
  fun aLateDetachCannotRemoveANewerSink() {
    var newerFrames = 0
    val older = DecodedFrameTap.attach({})
    val newer = DecodedFrameTap.attach({ newerFrames += 1 })
    assertFalse(DecodedFrameTap.detach(older))
    assertFalse(DecodedFrameTap.isCurrent(older))
    assertTrue(DecodedFrameTap.isCurrent(newer))
    DecodedFrameTap.offer(planes())
    assertEquals(1, newerFrames)
    assertTrue(DecodedFrameTap.detach(newer))
    assertFalse(DecodedFrameTap.hasSink())
  }
}
