package com.mentra.acsmeeting.audio

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class FakeScheduler : PolicyScheduler {
  data class Job(val atMs: Long, val task: () -> Unit)

  var nowMs = 0L
  private val jobs = mutableListOf<Job>()

  override fun schedule(delayMs: Long, task: () -> Unit) {
    jobs.add(Job(nowMs + delayMs, task))
  }

  override fun cancelPending() {
    jobs.clear()
  }

  fun pendingCount(): Int = jobs.size

  fun advanceTo(targetMs: Long) {
    while (true) {
      val next = jobs.filter { it.atMs <= targetMs }.minByOrNull { it.atMs } ?: break
      jobs.remove(next)
      nowMs = next.atMs
      next.task()
    }
    nowMs = targetMs
  }
}

class FakeAudioStreamController : AudioStreamController {
  var active: ActiveStreamKind = ActiveStreamKind.NONE
  var physicallyMuted: Boolean? = true
  var pcmEnabled: Boolean = false
  var phonePcm: Boolean = false
  var muteResult: Result<Unit> = Result.success(Unit)
  var unmuteResult: Result<Unit> = Result.success(Unit)
  var stopResult: Result<Unit> = Result.success(Unit)
  var muteSetsFlag: Boolean = true
  val pcmCalls = mutableListOf<Boolean>()
  val phonePcmCalls = mutableListOf<Boolean>()
  var muteCalls = 0
  var unmuteCalls = 0
  var stopCalls = 0

  override fun readActive(): ActiveStreamKind = active

  override fun isPhysicallyMuted(): Boolean? = physicallyMuted

  override fun setGlassesPcmEnabled(enabled: Boolean) {
    pcmEnabled = enabled
    pcmCalls.add(enabled)
  }

  override fun setPhonePcmEnabled(enabled: Boolean) {
    phonePcm = enabled
    phonePcmCalls.add(enabled)
  }

  override fun mutePhysical(): Result<Unit> {
    muteCalls += 1
    if (muteResult.isSuccess && muteSetsFlag) physicallyMuted = true
    return muteResult
  }

  override fun unmutePhysical(): Result<Unit> {
    unmuteCalls += 1
    if (unmuteResult.isSuccess) physicallyMuted = false
    return unmuteResult
  }

  override fun stopActive(): Result<Unit> {
    stopCalls += 1
    if (stopResult.isSuccess) active = ActiveStreamKind.NONE
    return stopResult
  }
}

class AudioPolicyApplierTest {
  private val controller = FakeAudioStreamController()
  private val scheduler = FakeScheduler()
  private val logs = mutableListOf<String>()
  private val applier = AudioPolicyApplier(controller, scheduler) { logs.add(it) }

  @Test
  fun noneNoneVirtual_opensGateOnThirdObservation() {
    controller.active = ActiveStreamKind.NONE
    applier.apply(AudioSourceKind.GLASSES, userMuted = false, reason = "join")
    assertThat(controller.pcmEnabled).isFalse()
    assertThat(controller.pcmCalls).containsExactly(false)

    scheduler.advanceTo(50)
    assertThat(controller.pcmEnabled).isFalse()
    assertThat(controller.pcmCalls).hasSize(2)

    controller.active = ActiveStreamKind.VIRTUAL
    scheduler.advanceTo(100)
    assertThat(controller.pcmEnabled).isTrue()
    assertThat(applier.lastSafety()).isEqualTo(AudioSafety.SAFE)
    assertThat(controller.unmuteCalls).isEqualTo(0)
  }

  @Test
  fun noneNoneVirtual_opensPhonePcmOnThirdObservation() {
    controller.active = ActiveStreamKind.NONE
    applier.apply(AudioSourceKind.PHONE, userMuted = false, reason = "join")
    assertThat(controller.phonePcm).isFalse()
    assertThat(controller.phonePcmCalls).containsExactly(false)
    assertThat(controller.unmuteCalls).isEqualTo(0)

    scheduler.advanceTo(50)
    assertThat(controller.phonePcm).isFalse()
    assertThat(controller.phonePcmCalls).hasSize(2)

    controller.active = ActiveStreamKind.VIRTUAL
    scheduler.advanceTo(100)
    assertThat(controller.phonePcm).isTrue()
    assertThat(controller.pcmEnabled).isFalse()
    assertThat(controller.unmuteCalls).isEqualTo(0)
    assertThat(applier.lastSafety()).isEqualTo(AudioSafety.SAFE)
  }

  @Test
  fun convergenceTimeout_holdsSilenceAndReportsDegraded() {
    controller.active = ActiveStreamKind.NONE
    applier.apply(AudioSourceKind.GLASSES, userMuted = false, reason = "join")
    scheduler.advanceTo(1600)
    assertThat(controller.pcmEnabled).isFalse()
    assertThat(applier.lastSafety()).isEqualTo(AudioSafety.DEGRADED)
    assertThat(logs.any { it.contains("convergence timed out") }).isTrue()
  }

  @Test
  fun muteFailureEscalatesToStop_safeWhenStopSucceeds() {
    controller.active = ActiveStreamKind.LOCAL
    controller.physicallyMuted = false
    controller.muteResult = Result.failure(IllegalStateException("no call"))
    val safety = applier.apply(AudioSourceKind.PHONE, userMuted = true, reason = "set-muted")
    assertThat(controller.muteCalls).isEqualTo(1)
    assertThat(controller.stopCalls).isEqualTo(1)
    assertThat(controller.active).isEqualTo(ActiveStreamKind.NONE)
    assertThat(safety).isEqualTo(AudioSafety.SAFE)
  }

  @Test
  fun muteAndStopFailure_isUnsafe() {
    controller.active = ActiveStreamKind.LOCAL
    controller.physicallyMuted = false
    controller.muteResult = Result.failure(IllegalStateException("mute failed"))
    controller.stopResult = Result.failure(IllegalStateException("stop failed"))
    val safety = applier.apply(AudioSourceKind.PHONE, userMuted = true, reason = "set-muted")
    assertThat(controller.stopCalls).isEqualTo(1)
    assertThat(controller.active).isEqualTo(ActiveStreamKind.LOCAL)
    assertThat(safety).isEqualTo(AudioSafety.UNSAFE)
  }

  @Test
  fun successfulMuteWithDisagreeingReadback_stillEscalates() {
    controller.active = ActiveStreamKind.LOCAL
    controller.physicallyMuted = false
    controller.muteSetsFlag = false
    controller.muteResult = Result.success(Unit)
    applier.apply(AudioSourceKind.PHONE, userMuted = true, reason = "set-muted")
    assertThat(controller.muteCalls).isEqualTo(1)
    assertThat(controller.stopCalls).isEqualTo(1)
    assertThat(controller.active).isEqualTo(ActiveStreamKind.NONE)
  }

  @Test
  fun unmuteFailure_isDegradedAndNeverStops() {
    controller.active = ActiveStreamKind.LOCAL
    controller.physicallyMuted = true
    controller.unmuteResult = Result.failure(IllegalStateException("unmute failed"))
    val safety = applier.apply(AudioSourceKind.PHONE, userMuted = false, reason = "set-muted")
    assertThat(controller.unmuteCalls).isEqualTo(1)
    assertThat(controller.stopCalls).isEqualTo(0)
    assertThat(safety).isEqualTo(AudioSafety.DEGRADED)
  }

  @Test
  fun applyTwice_doesNotRepeatAcsMute() {
    controller.active = ActiveStreamKind.LOCAL
    controller.physicallyMuted = true
    applier.apply(AudioSourceKind.PHONE, userMuted = false, reason = "join")
    assertThat(controller.unmuteCalls).isEqualTo(1)
    applier.apply(AudioSourceKind.PHONE, userMuted = false, reason = "call-connected")
    assertThat(controller.unmuteCalls).isEqualTo(1)
  }

  @Test
  fun applyGlassesVirtualTwice_neverUnmutesPhysical() {
    controller.active = ActiveStreamKind.VIRTUAL
    applier.apply(AudioSourceKind.GLASSES, userMuted = false, reason = "stream-started")
    applier.apply(AudioSourceKind.GLASSES, userMuted = false, reason = "call-connected")
    assertThat(controller.unmuteCalls).isEqualTo(0)
    assertThat(controller.muteCalls).isEqualTo(0)
    assertThat(controller.pcmEnabled).isTrue()
  }

  @Test
  fun staleConvergenceCannotOverwriteNewerDesiredState() {
    controller.active = ActiveStreamKind.NONE
    applier.apply(AudioSourceKind.GLASSES, userMuted = false, reason = "join")
    assertThat(scheduler.pendingCount()).isGreaterThan(0)
    applier.apply(AudioSourceKind.PHONE, userMuted = false, reason = "set-source")
    controller.active = ActiveStreamKind.VIRTUAL
    scheduler.advanceTo(100)
    assertThat(controller.pcmEnabled).isFalse()
    assertThat(controller.phonePcm).isTrue()
    assertThat(controller.unmuteCalls).isEqualTo(0)
  }

  @Test
  fun neverUnmutesWhileVirtualIsActive() {
    controller.active = ActiveStreamKind.VIRTUAL
    applier.apply(AudioSourceKind.PHONE, userMuted = false, reason = "mismatch")
    assertThat(controller.unmuteCalls).isEqualTo(0)
    assertThat(controller.pcmEnabled).isFalse()
    assertThat(controller.phonePcm).isTrue()
  }
}
