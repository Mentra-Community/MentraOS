package com.mentra.bluetoothsdk

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class VersionInfoResponseAccumulatorTest {
    @Test
    fun mergesCurrentChunksAndCompletesOnFirmwareChunk() {
        val accumulator = VersionInfoResponseAccumulator("request-1")

        assertThat(accumulator.accept(chunk("version_info_1", "request-1", "buildNumber" to "42")))
            .isEqualTo(VersionInfoAccumulatorOutcome.Waiting)

        val complete =
            accumulator.accept(
                chunk(
                    "version_info_3",
                    "request-1",
                    "buildNumber" to "",
                    "besFirmwareVersion" to "26.8.27.0",
                    "mtkFirmwareVersion" to "MentraLive_20260709",
                )
            ) as VersionInfoAccumulatorOutcome.Complete

        assertThat(complete.result.buildNumber).isEqualTo("42")
        assertThat(complete.result.besFirmwareVersion).isEqualTo("26.8.27.0")
        assertThat(complete.result.mtkFirmwareVersion).isEqualTo("MentraLive_20260709")
    }

    @Test
    fun ignoresMismatchedAndTrailingStaleChunks() {
        val accumulator = VersionInfoResponseAccumulator("request-1")

        assertThat(accumulator.accept(chunk("version_info_1", "other", "buildNumber" to "old")))
            .isEqualTo(VersionInfoAccumulatorOutcome.Ignored)
        assertThat(accumulator.accept(chunk("version_info_3", null, "besFirmwareVersion" to "stale")))
            .isEqualTo(VersionInfoAccumulatorOutcome.Ignored)
        assertThat(accumulator.finishAfterQuietPeriod()).isNull()
    }

    @Test
    fun doesNotMixCorrelatedAndUncorrelatedSequences() {
        val accumulator = VersionInfoResponseAccumulator("request-1")
        accumulator.accept(chunk("version_info_1", "request-1", "buildNumber" to "42"))

        assertThat(accumulator.accept(chunk("version_info_3", null, "besFirmwareVersion" to "stale")))
            .isEqualTo(VersionInfoAccumulatorOutcome.Ignored)

        val complete =
            accumulator.accept(
                chunk("version_info_3", "request-1", "besFirmwareVersion" to "current")
            ) as VersionInfoAccumulatorOutcome.Complete
        assertThat(complete.result.besFirmwareVersion).isEqualTo("current")
    }

    @Test
    fun repeatedFirstChunkResetsRatherThanMixingResponses() {
        val accumulator = VersionInfoResponseAccumulator("request-1")
        accumulator.accept(chunk("version_info_1", null, "appVersion" to "old"))
        accumulator.accept(chunk("version_info_1", null, "buildNumber" to "43"))

        assertThat(accumulator.accept(chunk("version_info_3", null, "besFirmwareVersion" to "new")))
            .isEqualTo(VersionInfoAccumulatorOutcome.Waiting)
        val complete = accumulator.finishAfterQuietPeriod()!!

        assertThat(complete.appVersion).isEmpty()
        assertThat(complete.buildNumber).isEqualTo("43")
        assertThat(complete.besFirmwareVersion).isEqualTo("new")
    }

    @Test
    fun legacySingleMessageCompletesImmediately() {
        val accumulator = VersionInfoResponseAccumulator("request-1")

        val complete =
            accumulator.accept(chunk("version_info", null, "buildNumber" to "7"))
                as VersionInfoAccumulatorOutcome.Complete

        assertThat(complete.result.buildNumber).isEqualTo("7")
    }

    @Test
    fun quietPeriodCanFinishOlderPartialChunkResponse() {
        val accumulator = VersionInfoResponseAccumulator("request-1")
        accumulator.accept(chunk("version_info_1", null, "buildNumber" to "8"))

        assertThat(accumulator.finishAfterQuietPeriod()?.buildNumber).isEqualTo("8")
    }

    private fun chunk(
        type: String,
        requestId: String?,
        vararg values: Pair<String, Any>,
    ): Map<String, Any> =
        buildMap {
            put(VersionInfoResponseAccumulator.RESPONSE_CHUNK_KEY, type)
            requestId?.let {
                put(VersionInfoResponseAccumulator.RESPONSE_REQUEST_ID_KEY, it)
            }
            putAll(values)
        }
}
