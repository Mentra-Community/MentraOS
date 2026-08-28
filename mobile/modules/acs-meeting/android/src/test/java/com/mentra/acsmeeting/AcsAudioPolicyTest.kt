package com.mentra.acsmeeting

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

class AcsAudioPolicyTest {
  @Test
  fun glassesVirtualUnmuted_sendsPcmAndLeavesPhysicalAlone() {
    assertRow(AudioSourceKind.GLASSES, ActiveStreamKind.VIRTUAL, false, true, PhysicalMuteAction.LEAVE_ALONE)
  }

  @Test
  fun glassesVirtualMuted_gatesPcmAndLeavesPhysicalAlone() {
    assertRow(AudioSourceKind.GLASSES, ActiveStreamKind.VIRTUAL, true, false, PhysicalMuteAction.LEAVE_ALONE)
  }

  @Test
  fun glassesLocalUnmuted_mutesHandsetAndGatesPcm() {
    assertRow(AudioSourceKind.GLASSES, ActiveStreamKind.LOCAL, false, false, PhysicalMuteAction.MUTE)
  }

  @Test
  fun glassesLocalMuted_mutesHandsetAndGatesPcm() {
    assertRow(AudioSourceKind.GLASSES, ActiveStreamKind.LOCAL, true, false, PhysicalMuteAction.MUTE)
  }

  @Test
  fun glassesNoneUnmuted_holdsSilence() {
    assertRow(AudioSourceKind.GLASSES, ActiveStreamKind.NONE, false, false, PhysicalMuteAction.LEAVE_ALONE)
  }

  @Test
  fun glassesNoneMuted_holdsSilence() {
    assertRow(AudioSourceKind.GLASSES, ActiveStreamKind.NONE, true, false, PhysicalMuteAction.LEAVE_ALONE)
  }

  @Test
  fun phoneLocalUnmuted_unmutesHandset() {
    assertRow(AudioSourceKind.PHONE, ActiveStreamKind.LOCAL, false, false, PhysicalMuteAction.UNMUTE)
  }

  @Test
  fun phoneLocalMuted_mutesHandset() {
    assertRow(AudioSourceKind.PHONE, ActiveStreamKind.LOCAL, true, false, PhysicalMuteAction.MUTE)
  }

  @Test
  fun phoneVirtualUnmuted_cannotMuteVirtual_holdsSilence() {
    assertRow(AudioSourceKind.PHONE, ActiveStreamKind.VIRTUAL, false, false, PhysicalMuteAction.LEAVE_ALONE)
  }

  @Test
  fun phoneVirtualMuted_cannotMuteVirtual_holdsSilence() {
    assertRow(AudioSourceKind.PHONE, ActiveStreamKind.VIRTUAL, true, false, PhysicalMuteAction.LEAVE_ALONE)
  }

  @Test
  fun phoneNoneUnmuted_holdsSilence() {
    assertRow(AudioSourceKind.PHONE, ActiveStreamKind.NONE, false, false, PhysicalMuteAction.LEAVE_ALONE)
  }

  @Test
  fun phoneNoneMuted_holdsSilence() {
    assertRow(AudioSourceKind.PHONE, ActiveStreamKind.NONE, true, false, PhysicalMuteAction.LEAVE_ALONE)
  }

  @Test
  fun cartesianProduct_neverLeaksWrongMicrophone() {
    for (desired in AudioSourceKind.entries) {
      for (active in ActiveStreamKind.entries) {
        for (userMuted in listOf(false, true)) {
          val decision = AcsAudioPolicy.decide(desired, active, userMuted)
          if (decision.glassesPcmEnabled) {
            assertThat(active).isEqualTo(ActiveStreamKind.VIRTUAL)
            assertThat(desired).isEqualTo(AudioSourceKind.GLASSES)
            assertThat(userMuted).isFalse()
          }
          if (decision.physicalMute == PhysicalMuteAction.UNMUTE) {
            assertThat(active).isEqualTo(ActiveStreamKind.LOCAL)
            assertThat(desired).isEqualTo(AudioSourceKind.PHONE)
            assertThat(userMuted).isFalse()
          }
        }
      }
    }
  }

  @Test
  fun planJoin_glassesRequiresUnmutedTransport_ignoresUserMute() {
    val muted = AcsAudioPolicy.planJoin(AudioSourceKind.GLASSES, userMuted = true, glassesRequiresUnmutedTransport = true)
    val unmuted = AcsAudioPolicy.planJoin(AudioSourceKind.GLASSES, userMuted = false, glassesRequiresUnmutedTransport = true)
    assertThat(muted.armVirtual).isTrue()
    assertThat(muted.transportMuted).isFalse()
    assertThat(unmuted.armVirtual).isTrue()
    assertThat(unmuted.transportMuted).isFalse()
  }

  @Test
  fun planJoin_glassesWithoutUnmutedRequirement_followsUserMute() {
    val muted = AcsAudioPolicy.planJoin(AudioSourceKind.GLASSES, userMuted = true, glassesRequiresUnmutedTransport = false)
    val unmuted = AcsAudioPolicy.planJoin(AudioSourceKind.GLASSES, userMuted = false, glassesRequiresUnmutedTransport = false)
    assertThat(muted.transportMuted).isTrue()
    assertThat(unmuted.transportMuted).isFalse()
    assertThat(muted.armVirtual).isTrue()
  }

  @Test
  fun planJoin_phoneAlwaysFollowsUserMute() {
    for (glassesFlag in listOf(true, false)) {
      val muted = AcsAudioPolicy.planJoin(AudioSourceKind.PHONE, userMuted = true, glassesRequiresUnmutedTransport = glassesFlag)
      val unmuted = AcsAudioPolicy.planJoin(AudioSourceKind.PHONE, userMuted = false, glassesRequiresUnmutedTransport = glassesFlag)
      assertThat(muted.armVirtual).isFalse()
      assertThat(unmuted.armVirtual).isFalse()
      assertThat(muted.transportMuted).isTrue()
      assertThat(unmuted.transportMuted).isFalse()
    }
  }

  @Test
  fun parseSource_allowlistOnly() {
    assertThat(AcsAudioPolicy.parseSource("glasses")).isEqualTo(AudioSourceKind.GLASSES)
    assertThat(AcsAudioPolicy.parseSource("phone")).isEqualTo(AudioSourceKind.PHONE)
    assertThat(AcsAudioPolicy.parseSource("bluetooth")).isNull()
    assertThat(AcsAudioPolicy.parseSource("auto")).isNull()
    assertThat(AcsAudioPolicy.parseSource(null)).isNull()
  }

  @Test
  fun callGuard_nullIsFailureNotSuccess() {
    val missing: Any? = null
    val result = CallGuard.require(missing)
    assertThat(result.isFailure).isTrue()
    assertThat(result.exceptionOrNull()).isInstanceOf(IllegalStateException::class.java)
    assertThat(result.exceptionOrNull()?.message).isEqualTo("no call")
  }

  @Test
  fun callGuard_presentIsSuccess() {
    assertThat(CallGuard.require("call").getOrThrow()).isEqualTo("call")
  }

  private fun assertRow(
    desired: AudioSourceKind,
    active: ActiveStreamKind,
    userMuted: Boolean,
    glassesPcm: Boolean,
    physicalMute: PhysicalMuteAction,
  ) {
    val decision = AcsAudioPolicy.decide(desired, active, userMuted)
    assertThat(decision.glassesPcmEnabled).isEqualTo(glassesPcm)
    assertThat(decision.physicalMute).isEqualTo(physicalMute)
  }
}

@RunWith(Parameterized::class)
class AcsAudioPolicyJoinMatrixTest(
  private val desired: AudioSourceKind,
  private val userMuted: Boolean,
  private val glassesRequiresUnmutedTransport: Boolean,
) {
  @Test
  fun armVirtualMatchesDesired() {
    val plan = AcsAudioPolicy.planJoin(desired, userMuted, glassesRequiresUnmutedTransport)
    assertThat(plan.armVirtual).isEqualTo(desired == AudioSourceKind.GLASSES)
    if (desired == AudioSourceKind.PHONE) {
      assertThat(plan.transportMuted).isEqualTo(userMuted)
    } else if (glassesRequiresUnmutedTransport) {
      assertThat(plan.transportMuted).isFalse()
    } else {
      assertThat(plan.transportMuted).isEqualTo(userMuted)
    }
  }

  companion object {
    @JvmStatic
    @Parameterized.Parameters(name = "{0} muted={1} glassesUnmutedTransport={2}")
    fun data(): List<Array<Any>> {
      val rows = mutableListOf<Array<Any>>()
      for (desired in AudioSourceKind.entries) {
        for (muted in listOf(false, true)) {
          for (flag in listOf(false, true)) {
            rows.add(arrayOf(desired, muted, flag))
          }
        }
      }
      return rows
    }
  }
}
