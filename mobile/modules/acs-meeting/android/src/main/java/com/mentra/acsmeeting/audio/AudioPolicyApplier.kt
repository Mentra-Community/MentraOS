package com.mentra.acsmeeting.audio

interface AudioStreamController {
  fun readActive(): ActiveStreamKind
  fun isPhysicallyMuted(): Boolean?
  fun setGlassesPcmEnabled(enabled: Boolean)
  fun setPhonePcmEnabled(enabled: Boolean)
  fun mutePhysical(): Result<Unit>
  fun unmutePhysical(): Result<Unit>
  fun stopActive(): Result<Unit>
}

interface PolicyScheduler {
  fun schedule(delayMs: Long, task: () -> Unit)
  fun cancelPending()
}

class AudioPolicyApplier(
  private val controller: AudioStreamController,
  private val scheduler: PolicyScheduler,
  private val log: (String) -> Unit = {},
) {
  private var generation = 0L
  private var lastDecision: AudioPolicyDecision? = null
  private var lastSafety: AudioSafety = AudioSafety.DEGRADED

  fun lastSafety(): AudioSafety = lastSafety

  fun apply(desired: AudioSourceKind, userMuted: Boolean, reason: String): AudioSafety {
    generation += 1
    scheduler.cancelPending()
    return runApply(desired, userMuted, reason, generation, force = false, armConvergence = true)
  }

  fun reset() {
    generation += 1
    scheduler.cancelPending()
    lastDecision = null
    lastSafety = AudioSafety.DEGRADED
  }

  private fun runApply(
    desired: AudioSourceKind,
    userMuted: Boolean,
    reason: String,
    gen: Long,
    force: Boolean,
    armConvergence: Boolean,
  ): AudioSafety {
    if (gen != generation) return lastSafety
    val active = controller.readActive()
    val decision = AcsAudioPolicy.decide(desired, active, userMuted)
    val outcome = applyDecision(decision, force)
    if (gen != generation) return lastSafety

    val after = controller.readActive()
    val expected = AcsAudioPolicy.expectedStream(desired)
    val safety = safetyOf(desired, after, outcome)
    lastDecision = decision
    lastSafety = safety
    log(
      "audio policy reason=$reason source=$desired userMuted=$userMuted " +
        "active=$after expected=$expected glassesPcm=${decision.glassesPcmEnabled} " +
        "phonePcm=${decision.phonePcmEnabled} mute=${decision.physicalMute} safety=$safety",
    )

    if (after == expected) {
      scheduler.cancelPending()
    } else if (armConvergence && gen == generation) {
      armConvergence(desired, userMuted, gen, expected)
    }
    return lastSafety
  }

  private fun armConvergence(
    desired: AudioSourceKind,
    userMuted: Boolean,
    gen: Long,
    expected: ActiveStreamKind,
  ) {
    CONVERGE_DELAYS_MS.forEachIndexed { index, delayMs ->
      scheduler.schedule(delayMs) {
        if (gen != generation) return@schedule
        val isLast = index == CONVERGE_DELAYS_MS.lastIndex
        runApply(desired, userMuted, "converge-${delayMs}ms", gen, force = true, armConvergence = false)
        if (isLast && gen == generation && controller.readActive() != expected) {
          log("audio policy convergence timed out source=$desired expected=$expected holding silence")
          lastSafety = AudioSafety.DEGRADED
        }
      }
    }
  }

  private fun applyDecision(decision: AudioPolicyDecision, force: Boolean): EffectOutcome {
    val previous = lastDecision
    val skipGlassesPcm = !force && previous != null && previous.glassesPcmEnabled == decision.glassesPcmEnabled
    val skipPhonePcm = !force && previous != null && previous.phonePcmEnabled == decision.phonePcmEnabled
    val skipMute = !force && previous != null && previous.physicalMute == decision.physicalMute
    if (!skipGlassesPcm) {
      controller.setGlassesPcmEnabled(decision.glassesPcmEnabled)
    }
    if (!skipPhonePcm) {
      controller.setPhonePcmEnabled(decision.phonePcmEnabled)
    }
    if (skipMute) return EffectOutcome.NONE

    return when (decision.physicalMute) {
      PhysicalMuteAction.LEAVE_ALONE -> EffectOutcome.NONE
      PhysicalMuteAction.UNMUTE -> {
        val result = controller.unmutePhysical()
        val unmuted = controller.isPhysicallyMuted()
        val failed = result.isFailure || unmuted == true
        EffectOutcome(unmuteAttempted = true, unmuteFailed = failed)
      }
      PhysicalMuteAction.MUTE -> {
        val result = controller.mutePhysical()
        val muted = controller.isPhysicallyMuted()
        val muteFailed = result.isFailure || muted == false
        if (!muteFailed) return EffectOutcome(muteAttempted = true)
        val stop = controller.stopActive()
        val stopped = controller.readActive() == ActiveStreamKind.NONE
        EffectOutcome(
          muteAttempted = true,
          muteFailed = true,
          stopAttempted = true,
          stopFailed = stop.isFailure || !stopped,
        )
      }
    }
  }

  private fun safetyOf(
    desired: AudioSourceKind,
    active: ActiveStreamKind,
    outcome: EffectOutcome,
  ): AudioSafety {
    if (outcome.stopFailed) return AudioSafety.UNSAFE
    if (outcome.stopAttempted) return AudioSafety.SAFE
    if (outcome.unmuteFailed) return AudioSafety.DEGRADED
    val expected = AcsAudioPolicy.expectedStream(desired)
    if (active != expected) return AudioSafety.DEGRADED
    return AudioSafety.SAFE
  }

  private data class EffectOutcome(
    val muteAttempted: Boolean = false,
    val muteFailed: Boolean = false,
    val unmuteAttempted: Boolean = false,
    val unmuteFailed: Boolean = false,
    val stopAttempted: Boolean = false,
    val stopFailed: Boolean = false,
  ) {
    companion object {
      val NONE = EffectOutcome()
    }
  }

  companion object {
    val CONVERGE_DELAYS_MS = longArrayOf(50, 100, 200, 400, 800, 1600)
  }
}

class ExecutorPolicyScheduler(
  private val executor: java.util.concurrent.ScheduledExecutorService,
) : PolicyScheduler {
  private val pending = java.util.concurrent.CopyOnWriteArrayList<java.util.concurrent.ScheduledFuture<*>>()

  override fun schedule(delayMs: Long, task: () -> Unit) {
    pending.add(executor.schedule(task, delayMs, java.util.concurrent.TimeUnit.MILLISECONDS))
  }

  override fun cancelPending() {
    pending.forEach { it.cancel(false) }
    pending.clear()
  }
}
