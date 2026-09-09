package com.mentra.acsmeeting.audio

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

/**
 * The mute contract, stage by stage.
 *
 * These are not tests that mute sets a flag. They populate every stage that can hold the wearer's
 * voice and then assert that nothing which was in them ever reaches the pacer — which is the only
 * form of the guarantee that means anything to someone who pressed Mute mid-sentence.
 */
class AudioUplinkChainTest {
  private val rate = 16_000
  private val nativeRate = UplinkPacer.RATE
  private val bytesPerMs = rate * 2 / 1000
  private val nativeBytesPerMs = UplinkPacer.BYTES_PER_MS

  /** 16 kHz mono PCM16 at a constant non-zero level, so silence is distinguishable from voice. */
  private fun voice(ms: Int): ByteArray = ByteArray(ms * bytesPerMs) { 0x20 }

  /**
   * The same at ACS's own 48 kHz mono, which the bridge passes through untouched.
   *
   * The stage tests below assert on exact frame boundaries, and the 16 kHz interpolator cannot give
   * them: it drops its last partial sample pair per call, so a 20 ms buffer resamples to slightly
   * under a 20 ms frame. Feeding the native rate keeps the byte arithmetic exact so an assertion
   * that fails means a stage held audio, not that the resampler rounded.
   */
  private fun nativeVoice(ms: Int): ByteArray = ByteArray(ms * nativeBytesPerMs) { 0x20 }

  private fun bridge() = PcmBridge(null, false)

  private class FakeClock(var nanos: Long = 0L) : () -> Long {
    override fun invoke(): Long = nanos

    fun advanceMs(ms: Long) {
      nanos += ms * 1_000_000L
    }
  }

  @Test
  fun resamplesSixteenKilohertzMonoPreservingDuration() {
    val pacer = UplinkPacer()
    val chain = AudioUplinkChain(bridge(), pacer)

    // A second of 16 kHz input is a second of 48 kHz output. The interpolator's tail leaves at most
    // one partial 20 ms frame in the bridge, so the pacer holds a whole second bar that frame.
    repeat(100) { chain.ingest(voice(10), rate, 1) }

    assertThat(pacer.depthMs()).isBetween(980, 1_000)
  }

  @Test
  fun mutedIngestNeverEntersAnyStage() {
    val pacer = UplinkPacer()
    val chain = AudioUplinkChain(bridge(), pacer)

    chain.mute()
    repeat(100) { chain.ingest(voice(10), rate, 1) }

    assertThat(pacer.depthMs()).isEqualTo(0)
  }

  /**
   * The failure this whole class exists for. Gating new input is not mute: at the moment the button
   * is pressed the delay ring holds up to its full window, the resampler holds a partial 20 ms
   * frame, and the pacer holds its target headroom. All three keep draining unless mute clears them.
   */
  @Test
  fun muteClearsTheDelayRingTheBridgeRemainderAndThePacer() {
    val clock = FakeClock()
    val pacer = UplinkPacer()
    val chain = AudioUplinkChain(bridge(), pacer, delayMs = 200, clock = clock)

    // 400 ms of input against a 200 ms hold: 200 ms has reached the pacer, 200 ms is still held.
    repeat(40) {
      chain.ingest(nativeVoice(10), nativeRate, 1)
      clock.advanceMs(10)
    }
    // One more releases a 21st 10 ms chunk, so the bridge is left holding half of a 20 ms frame.
    chain.ingest(nativeVoice(10), nativeRate, 1)
    assertThat(pacer.depthMs()).isGreaterThan(UplinkPacer.TARGET_MS)
    assertThat(chain.delayedBytes()).isGreaterThan(0)

    chain.mute()

    assertThat(pacer.depthMs()).isEqualTo(0)
    assertThat(chain.delayedBytes()).isEqualTo(0)

    // And the bridge remainder is gone too. After unmute, the first 10 ms to clear the delay ring
    // must not complete a 20 ms frame — it could only do so by pairing with the half-frame the
    // wearer spoke before pressing Mute. It takes two fresh chunks to make the first whole frame.
    chain.unmute()
    chain.ingest(nativeVoice(10), nativeRate, 1)
    clock.advanceMs(200)
    chain.ingest(nativeVoice(10), nativeRate, 1)
    assertThat(pacer.depthMs()).isEqualTo(0)
    clock.advanceMs(200)
    chain.ingest(nativeVoice(10), nativeRate, 1)
    assertThat(pacer.depthMs()).isEqualTo(20)
  }

  @Test
  fun unmuteAcceptsAudioAgain() {
    val pacer = UplinkPacer()
    val chain = AudioUplinkChain(bridge(), pacer)

    chain.mute()
    chain.ingest(nativeVoice(20), nativeRate, 1)
    chain.unmute()
    chain.ingest(nativeVoice(20), nativeRate, 1)

    assertThat(chain.isMuted()).isFalse()
    // Exactly one frame: the buffer ingested while muted was dropped, not deferred.
    assertThat(pacer.depthMs()).isEqualTo(20)
  }

  @Test
  fun resetDropsBufferedAudioWithoutMuting() {
    val pacer = UplinkPacer()
    val chain = AudioUplinkChain(bridge(), pacer)
    chain.ingest(nativeVoice(100), nativeRate, 1)

    chain.reset()

    assertThat(pacer.depthMs()).isEqualTo(0)
    assertThat(chain.isMuted()).isFalse()
    chain.ingest(nativeVoice(20), nativeRate, 1)
    assertThat(pacer.depthMs()).isEqualTo(20)
  }

  /**
   * `ingest` runs on the BLE/JS thread and `mute` on the caller's. Without one lock across both,
   * mute can clear the pacer while an ingest is midway through pushing into it, and the frames that
   * land after the clear are voice from before the mute.
   */
  @Test
  fun aMuteRacingIngestNeverLeavesVoiceBehind() {
    repeat(200) {
      val pacer = UplinkPacer()
      val chain = AudioUplinkChain(bridge(), pacer)
      val ready = CountDownLatch(2)
      val go = CountDownLatch(1)

      val producer = Thread {
        ready.countDown()
        go.await()
        repeat(20) { chain.ingest(voice(20), rate, 1) }
      }
      val muter = Thread {
        ready.countDown()
        go.await()
        chain.mute()
      }
      producer.start()
      muter.start()
      assertThat(ready.await(5, TimeUnit.SECONDS)).isTrue()
      go.countDown()
      producer.join(5_000)
      muter.join(5_000)

      assertThat(chain.isMuted()).isTrue()
      // Whatever interleaving happened, the last thing to run under the lock was either the mute
      // (which clears) or an ingest that saw `muted` and dropped. Neither leaves audio buffered.
      assertThat(pacer.depthMs()).isEqualTo(0)
    }
  }

  @Test
  fun aZeroDelayIsPassthrough() {
    val clock = FakeClock()
    val pacer = UplinkPacer()
    val chain = AudioUplinkChain(bridge(), pacer, delayMs = 0, clock = clock)

    chain.ingest(nativeVoice(20), nativeRate, 1)

    assertThat(chain.delayedBytes()).isEqualTo(0)
    assertThat(pacer.depthMs()).isEqualTo(20)
  }

  @Test
  fun aConfiguredDelayHoldsInputUntilItIsOldEnough() {
    val clock = FakeClock()
    val pacer = UplinkPacer()
    val chain = AudioUplinkChain(bridge(), pacer, delayMs = 120, clock = clock)

    // 100 ms of input, none of it yet 120 ms old.
    repeat(10) {
      chain.ingest(nativeVoice(10), nativeRate, 1)
      clock.advanceMs(10)
    }
    assertThat(pacer.depthMs()).isEqualTo(0)
    assertThat(chain.delayedBytes()).isEqualTo(100 * nativeBytesPerMs)

    // Once the two oldest chunks are 120 ms old they come out together, in arrival order.
    clock.advanceMs(30)
    chain.ingest(nativeVoice(10), nativeRate, 1)
    assertThat(pacer.depthMs()).isEqualTo(20)
  }

  @Test
  fun aDelayBeyondTheCeilingIsClamped() {
    val clock = FakeClock()
    val pacer = UplinkPacer()
    val chain = AudioUplinkChain(bridge(), pacer, delayMs = 5_000, clock = clock)

    repeat(60) {
      chain.ingest(voice(10), rate, 1)
      clock.advanceMs(10)
    }

    // Clamped to 500 ms, so by 600 ms of input the first 100 ms have already been released.
    assertThat(pacer.depthMs()).isGreaterThan(0)
    assertThat(chain.delayedBytes()).isLessThanOrEqualTo(AudioUplinkChain.MAX_DELAY_MS * bytesPerMs)
  }

  /** A clock that does not advance must not turn a bounded hold into an unbounded one. */
  @Test
  fun aStoppedClockDoesNotGrowTheDelayRingWithoutBound() {
    val pacer = UplinkPacer()
    val chain = AudioUplinkChain(bridge(), pacer, delayMs = 100, clock = { 0L })

    repeat(500) { chain.ingest(voice(10), rate, 1) }

    assertThat(chain.delayedBytes()).isLessThanOrEqualTo(100 * AudioUplinkChain.MAX_BYTES_PER_MS)
  }
}
