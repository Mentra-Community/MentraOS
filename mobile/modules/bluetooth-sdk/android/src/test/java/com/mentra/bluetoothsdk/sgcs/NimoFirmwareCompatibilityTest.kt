package com.mentra.bluetoothsdk.sgcs

import android.content.Context
import com.mentra.bluetoothsdk.sgcs.nimo.NimoFirmwareCompatibility
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NimoFirmwareCompatibilityTest {
  private val known = "FW-VERSION-v0.1.1.1-20260827164351-537cf1-dirty-Debug"
  private fun preferences() = RuntimeEnvironment.getApplication().getSharedPreferences(java.util.UUID.randomUUID().toString(), Context.MODE_PRIVATE)

  @Test fun bundledCompatibilityRequiresFullAndPackedIdentity() {
    val policy = NimoFirmwareCompatibility("one", preferences())
    assertTrue(policy.allows(known, "0.1.1.1"))
    assertFalse(policy.allows(known, "0.1.0.14"))
    assertFalse(policy.allows("FW-VERSION-v0.1.1.1-other-build", "0.1.1.1"))
    assertFalse(policy.allows("FW-VERSION-v0.2.0.0-newer", "0.2.0.0"))
    assertFalse(policy.allows("", ""))
  }

  @Test fun verifiedPolicySurvivesRestartOnlyForItsDevice() {
    val storage = preferences()
    val full = "FW-VERSION-v0.1.2.0-approved-build"
    NimoFirmwareCompatibility("one", storage).configure(mapOf("manifestSha256" to "a".repeat(64),
      "compatibleFirmware" to """[{"fullVersion":"$full","packedVersion":"0.1.2.0"}]"""))
    assertTrue(NimoFirmwareCompatibility("one", storage).allows(full, "0.1.2.0"))
    assertFalse(NimoFirmwareCompatibility("another", storage).allows(full, "0.1.2.0"))
  }

  @Test fun invalidPolicyCannotEnableUnknownFirmware() {
    val policy = NimoFirmwareCompatibility("one", preferences())
    for (json in listOf("{}", "[{}]", """[{"fullVersion":"FW-VERSION-v0.1.2.0-build","packedVersion":"0.1.1.1"}]""",
      """[{"fullVersion":"FW-VERSION-v0.1.2.4096-build","packedVersion":"0.1.2.4096"}]""")) {
      assertThrows(Exception::class.java) { policy.configure(mapOf("manifestSha256" to "a".repeat(64), "compatibleFirmware" to json)) }
    }
    assertThrows(Exception::class.java) { policy.configure(mapOf("manifestSha256" to "", "compatibleFirmware" to "[]")) }
    assertTrue(policy.allows(known, "0.1.1.1"))
  }

  @Test fun connectionQueriesRemainAvailableButNormalDeviceCommandsAreRestricted() {
    assertTrue(NimoFirmwareCompatibility.permitsBeforeCompatibility(NimoProtocol.CMD_GET_PARAMETER, NimoProtocol.GET_VERSION))
    assertTrue(NimoFirmwareCompatibility.permitsBeforeCompatibility(NimoProtocol.CMD_SET_PARAMETER, NimoProtocol.SET_TIME))
    assertTrue(NimoFirmwareCompatibility.permitsBeforeCompatibility(NimoProtocol.CMD_SET_PARAMETER, NimoProtocol.SET_PHONE_TYPE))
    assertFalse(NimoFirmwareCompatibility.permitsBeforeCompatibility(NimoProtocol.CMD_SET_PARAMETER, NimoProtocol.SET_BRIGHTNESS))
    assertFalse(NimoFirmwareCompatibility.permitsBeforeCompatibility(NimoProtocol.CMD_CONTROL_INSTRUCTION, NimoProtocol.CTRL_UPDATE_CONTENT))
  }
}
