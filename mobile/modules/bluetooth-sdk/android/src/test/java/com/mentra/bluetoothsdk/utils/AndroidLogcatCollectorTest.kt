package com.mentra.bluetoothsdk.utils

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AndroidLogcatCollectorTest {
    @Test
    fun parsesEpochLogcatWithNativeMetadata() {
        val parsed =
            AndroidLogcatCollector.parseEpochLine(
                " 1788222984.125  1234  5678 W MentraLive: Requested MTU size",
            )

        assertEquals(1_788_222_984_125L, parsed?.get("timestamp"))
        assertEquals("warn", parsed?.get("level"))
        assertEquals("Requested MTU size", parsed?.get("message"))
        assertEquals("android-logcat", parsed?.get("source"))
        assertEquals(
            mapOf("tag" to "MentraLive", "pid" to 1234, "tid" to 5678, "priority" to "W"),
            parsed?.get("metadata"),
        )
    }

    @Test
    fun mapsFatalLogsToError() {
        val parsed = AndroidLogcatCollector.parseEpochLine("1788222984.999 1 2 F AndroidRuntime: crash")

        assertEquals("error", parsed?.get("level"))
    }

    @Test
    fun ignoresNonEntryLines() {
        assertNull(AndroidLogcatCollector.parseEpochLine("--------- beginning of main"))
    }
}
