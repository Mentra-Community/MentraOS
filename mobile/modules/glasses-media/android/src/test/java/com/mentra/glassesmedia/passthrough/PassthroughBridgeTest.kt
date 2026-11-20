package com.mentra.glassesmedia.passthrough

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class PassthroughBridgeTest {
  @Test
  fun theFirstFrameOutMustBeAKeyFrame() {
    assertThat(PassthroughBridge().isWaitingForKeyFrame()).isTrue()
  }

  @Test
  fun aKeyFrameClosesTheWait() {
    val bridge = PassthroughBridge()
    bridge.keyFrameForwarded()
    assertThat(bridge.isWaitingForKeyFrame()).isFalse()
  }

  @Test
  fun aLossOpensTheWaitAgainAndIsCountedOnce() {
    val bridge = PassthroughBridge()
    bridge.keyFrameForwarded()
    bridge.wantKeyFrame("loss")
    bridge.wantKeyFrame("loss again while already waiting")
    assertThat(bridge.isWaitingForKeyFrame()).isTrue()
    assertThat(bridge.snapshot().keyFrameRequests).isEqualTo(1)
  }

  @Test
  fun theOwnerIsToldWhyTheWaitOpened() {
    val bridge = PassthroughBridge()
    bridge.keyFrameForwarded()
    val reasons = mutableListOf<String>()
    bridge.onKeyFrameWanted = { reasons += it }
    bridge.wantKeyFrame("publisher queue full")
    assertThat(reasons).containsExactly("publisher queue full")
  }

  @Test
  fun aFailingListenerCannotReachLibwebrtc() {
    val bridge = PassthroughBridge()
    bridge.keyFrameForwarded()
    bridge.onKeyFrameWanted = { error("log sink broke") }
    bridge.wantKeyFrame("loss")
    assertThat(bridge.isWaitingForKeyFrame()).isTrue()
  }

  @Test
  fun sequencesAreGapFreeAndMonotonicSoTheEncoderCanDetectDrops() {
    val bridge = PassthroughBridge()
    assertThat(bridge.nextSequence()).isEqualTo(0L)
    assertThat(bridge.nextSequence()).isEqualTo(1L)
    assertThat(bridge.nextSequence()).isEqualTo(2L)
  }

  @Test
  fun countersTrackWhatWentThrough() {
    val bridge = PassthroughBridge()
    bridge.noteIn(); bridge.noteIn(); bridge.noteIn()
    bridge.noteDropped()
    bridge.noteOut(100, keyFrame = true)
    bridge.noteOut(40, keyFrame = false)
    val snapshot = bridge.snapshot()
    assertThat(snapshot.framesIn).isEqualTo(3)
    assertThat(snapshot.framesDropped).isEqualTo(1)
    assertThat(snapshot.framesOut).isEqualTo(2)
    assertThat(snapshot.keyFramesOut).isEqualTo(1)
    assertThat(snapshot.bytesOut).isEqualTo(140)
  }
}
