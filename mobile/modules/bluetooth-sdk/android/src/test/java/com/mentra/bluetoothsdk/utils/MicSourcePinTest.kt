package com.mentra.bluetoothsdk.utils

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.Test

class MicSourcePinTest {
  private val auto = MicMap.map.getValue("auto")

  @Test
  fun noPinLeavesTheRankingAlone() {
    assertThat(MicSourcePin.selectionOrder(auto, null)).isEqualTo(auto)
  }

  /**
   * The whole point of the pin: with the glasses microphone unavailable, an unpinned selection
   * walks on to the phone. That fallback is right for captions and wrong for a call, so a pin has
   * to remove the other sources rather than merely prefer the glasses.
   */
  @Test
  fun aPinRemovesTheFallbacksRatherThanReorderingThem() {
    val order = MicSourcePin.selectionOrder(auto, MicTypes.GLASSES_CUSTOM)

    assertThat(order).containsExactly(MicTypes.GLASSES_CUSTOM)
    assertThat(order).doesNotContain(MicTypes.PHONE_INTERNAL, MicTypes.BLUETOOTH, MicTypes.BLUETOOTH_CLASSIC)
  }

  @Test
  fun aPinOutranksAPhoneFirstPreference() {
    // `preferred_mic = phone` is an STT preference. It must not decide who a Teams call hears.
    assertThat(MicSourcePin.selectionOrder(MicMap.map.getValue("phone"), MicTypes.GLASSES_CUSTOM))
      .containsExactly(MicTypes.GLASSES_CUSTOM)
  }

  @Test
  fun releasingRestoresEveryOtherConsumersPreference() {
    val phoneFirst = MicMap.map.getValue("phone")
    assertThat(MicSourcePin.selectionOrder(phoneFirst, MicSourcePin.normalize(null)))
      .isEqualTo(phoneFirst)
  }

  @Test
  fun blankAndNullBothMeanUnpinned() {
    assertThat(MicSourcePin.normalize(null)).isNull()
    assertThat(MicSourcePin.normalize("")).isNull()
    assertThat(MicSourcePin.normalize("   ")).isNull()
  }

  @Test
  fun theGlassesSourceIsAcceptedAndTrimmed() {
    assertThat(MicSourcePin.normalize(MicTypes.GLASSES_CUSTOM)).isEqualTo(MicTypes.GLASSES_CUSTOM)
    assertThat(MicSourcePin.normalize(" glasses ")).isEqualTo(MicTypes.GLASSES_CUSTOM)
  }

  /**
   * Pinning any other source would strand selection on a microphone no consumer asked for, and
   * failing loudly beats a call that silently pins the phone — the exact outcome the pin exists to
   * prevent.
   */
  @Test
  fun everyOtherSourceIsRejected() {
    for (source in listOf(MicTypes.PHONE_INTERNAL, MicTypes.BLUETOOTH, MicTypes.BLUETOOTH_CLASSIC, "auto")) {
      assertThatThrownBy { MicSourcePin.normalize(source) }
        .isInstanceOf(IllegalArgumentException::class.java)
        .hasMessageContaining(source)
    }
  }
}
