package com.mentra.bluetoothsdk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class VersionInfoBridgeTest {
    @Test
    fun wireMetadataSurvivesBridgeNormalizationAndCompletesOnlyAfterBothChunks() {
        val accumulator = VersionInfoResponseAccumulator("request-1")
        val outcomes = mutableListOf<VersionInfoAccumulatorOutcome>()
        val sink = Bridge.addEventSink { type, body ->
            if (type == "version_info") outcomes.add(accumulator.accept(body))
        }
        val common = mapOf<String, Any>("request_id" to "request-1", "sid" to "asg-1", "chunkCount" to 2)
        try {
            Bridge.sendVersionInfo(common + mapOf("chunkIndex" to 1, "final" to false, "build_number" to "42"), "version_info_1")
            Bridge.sendVersionInfo(common + mapOf("chunkIndex" to 2, "final" to true, "bes_fw_version" to "new"), "version_info_3")
            assertEquals(VersionInfoAccumulatorOutcome.Waiting, outcomes[0])
            val complete = outcomes[1] as VersionInfoAccumulatorOutcome.Complete
            assertEquals("42", complete.result.buildNumber)
            assertEquals("new", complete.result.besFirmwareVersion)
            assertTrue(complete.result.toMap().keys.none { it.startsWith("_response") })
        } finally {
            Bridge.removeEventSink(sink)
        }
    }
}
