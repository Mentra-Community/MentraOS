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
    fun redactsSecretBearingMessages() {
        val parsed =
            AndroidLogcatCollector.parseEpochLine(
                "1788222984.999 1 2 D AuthClient: Bearer private-value",
            )

        assertEquals("[REDACTED]", parsed?.get("message"))
    }

    @Test
    fun redactsCompoundCredentialNamesWithUnderscores() {
        val accessToken =
            AndroidLogcatCollector.parseEpochLine(
                "1788222984.999 1 2 D AuthClient: access_token=private-value",
            )
        val clientSecret =
            AndroidLogcatCollector.parseEpochLine(
                "1788222984.999 1 2 D AuthClient: client_secret: private-value",
            )

        assertEquals("[REDACTED]", accessToken?.get("message"))
        assertEquals("[REDACTED]", clientSecret?.get("message"))
    }

    @Test
    fun preservesBenignKeyAndAuthenticationMessages() {
        val cacheKey =
            AndroidLogcatCollector.parseEpochLine(
                "1788222984.999 1 2 D Cache: cache key lookup completed",
            )
        val authentication =
            AndroidLogcatCollector.parseEpochLine(
                "1788222984.999 1 2 I MentraLive: authentication completed",
            )

        assertEquals("cache key lookup completed", cacheKey?.get("message"))
        assertEquals("authentication completed", authentication?.get("message"))
    }

    @Test
    fun collectsDebugAndHigherForOnlyTheAppProcess() {
        val command = AndroidLogcatCollector.logcatCommand(1234)

        assertEquals("--pid=1234", command[1])
        assertEquals("*:D", command.last())
    }

    @Test
    fun ignoresNonEntryLines() {
        assertNull(AndroidLogcatCollector.parseEpochLine("--------- beginning of main"))
    }
}
