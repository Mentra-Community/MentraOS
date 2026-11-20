package com.mentra.glassesmedia.source

import java.nio.ByteBuffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class RelayFrameFanOutTest {
  private var generation: Long? = null

  private fun planes(): I420Planes {
    val y = ByteBuffer.allocate(16)
    val c = ByteBuffer.allocate(4)
    return I420Planes(y, 4, c, 2, c.duplicate(), 2, 4, 4, 0L)
  }

  private fun attach(producer: DecodedFrameProducer, sink: (I420Planes) -> Unit) {
    generation = DecodedFrameTap.attach(VideoFrameListener { sink(it) }, producer)
  }

  @After
  fun tearDown() {
    generation?.let { DecodedFrameTap.detach(it) }
    DecodedFrameTap.drainMetrics()
  }

  @Test
  fun thePublisherGetsEveryFrameBeforeThePreview() {
    val order = mutableListOf<String>()
    attach(DecodedFrameProducer.RELAY) { order += "preview" }
    val fanOut = relayFrameFanOut { order += "publisher" }
    fanOut.onVideoFrame(planes())
    fanOut.onVideoFrame(planes())
    assertEquals(listOf("publisher", "preview", "publisher", "preview"), order)
  }

  @Test
  fun bothConsumersSeeTheSameFrame() {
    var published: I420Planes? = null
    var previewed: I420Planes? = null
    attach(DecodedFrameProducer.RELAY) { previewed = it }
    val frame = planes()
    relayFrameFanOut { published = it }.onVideoFrame(frame)
    assertSame(frame, published)
    assertSame(frame, previewed)
  }

  @Test
  fun publishingIsUnaffectedWithNoPreviewAttached() {
    var published = 0
    val fanOut = relayFrameFanOut { published += 1 }
    repeat(3) { fanOut.onVideoFrame(planes()) }
    assertEquals(3, published)
    assertEquals(0L, DecodedFrameTap.drainMetrics().framesOffered)
  }

  @Test
  fun aThrowingPreviewNeverInterruptsPublishing() {
    var published = 0
    attach(DecodedFrameProducer.RELAY) { throw IllegalStateException("preview") }
    val fanOut = relayFrameFanOut { published += 1 }
    repeat(3) { fanOut.onVideoFrame(planes()) }
    assertEquals(3, published)
    assertEquals(3L, DecodedFrameTap.drainMetrics().sinkExceptions)
  }

  /** A Teams call's ACS preview must never be handed the relay's copy of the stream. */
  @Test
  fun anAcsPreviewNeverReceivesRelayFrames() {
    var previewed = 0
    var published = 0
    attach(DecodedFrameProducer.ACS) { previewed += 1 }
    val fanOut = relayFrameFanOut { published += 1 }
    repeat(3) { fanOut.onVideoFrame(planes()) }
    assertEquals(3, published)
    assertEquals(0, previewed)
  }
}
