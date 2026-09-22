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
    fun staleUncorrelatedResponsesCannotReplaceCorrelatedSequence() {
        val accumulator = VersionInfoResponseAccumulator("request-1")
        accumulator.accept(chunk("version_info_1", "request-1", "buildNumber" to "42"))

        assertThat(accumulator.accept(chunk("version_info_1", null, "buildNumber" to "stale")))
            .isEqualTo(VersionInfoAccumulatorOutcome.Ignored)
        assertThat(accumulator.accept(chunk("version_info", null, "buildNumber" to "legacy")))
            .isEqualTo(VersionInfoAccumulatorOutcome.Ignored)

        val complete =
            accumulator.accept(
                chunk("version_info_3", "request-1", "besFirmwareVersion" to "current")
            ) as VersionInfoAccumulatorOutcome.Complete
        assertThat(complete.result.buildNumber).isEqualTo("42")
        assertThat(complete.result.besFirmwareVersion).isEqualTo("current")
    }

    @Test
    fun repeatedFirstChunkResetsRatherThanMixingResponses() {
        val accumulator = VersionInfoResponseAccumulator("request-1")
        accumulator.accept(chunk("version_info_1", null, "appVersion" to "old"))
        accumulator.accept(chunk("version_info_1", null, "buildNumber" to "43"))

        val complete = (accumulator.accept(chunk("version_info_3", null, "besFirmwareVersion" to "new"))
            as VersionInfoAccumulatorOutcome.Complete).result

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
    fun legacyFirstChunkDoesNotCompleteWithoutFinalChunk() {
        val accumulator = VersionInfoResponseAccumulator("request-1")
        assertThat(accumulator.accept(chunk("version_info_1", null, "buildNumber" to "8")))
            .isEqualTo(VersionInfoAccumulatorOutcome.Waiting)
    }

    @Test
    fun modernFinalChunkWaitsForMissingFirstChunk() {
        val accumulator = VersionInfoResponseAccumulator("request-1")
        assertThat(accumulator.accept(chunk("version_info_3", "request-1", "besFirmwareVersion" to "new")))
            .isEqualTo(VersionInfoAccumulatorOutcome.Waiting)
        val result = accumulator.accept(chunk("version_info_1", "request-1", "buildNumber" to "42"))
            as VersionInfoAccumulatorOutcome.Complete
        assertThat(result.result.buildNumber).isEqualTo("42")
        assertThat(result.result.besFirmwareVersion).isEqualTo("new")
    }

    @Test
    fun duplicateChunkDoesNotCountAsMissingChunk() {
        val accumulator = VersionInfoResponseAccumulator("request-1")
        val first = chunk("version_info_1", "request-1", "buildNumber" to "42")
        assertThat(accumulator.accept(first)).isEqualTo(VersionInfoAccumulatorOutcome.Waiting)
        assertThat(accumulator.accept(first)).isEqualTo(VersionInfoAccumulatorOutcome.Waiting)
    }

    @Test
    fun rejectsMalformedModernMetadataAndMixedProcess() {
        val accumulator = VersionInfoResponseAccumulator("request-1")
        val first = chunk("version_info_1", "request-1", "buildNumber" to "42")
        for ((key, value) in listOf(
            VersionInfoResponseAccumulator.RESPONSE_COUNT_KEY to 2.5,
            VersionInfoResponseAccumulator.RESPONSE_INDEX_KEY to true,
            VersionInfoResponseAccumulator.RESPONSE_FINAL_KEY to true,
            VersionInfoResponseAccumulator.RESPONSE_REQUEST_ID_KEY to "",
        )) {
            assertThat(accumulator.accept(first + (key to value))).isEqualTo(VersionInfoAccumulatorOutcome.Ignored)
        }
        accumulator.accept(first)
        val last = chunk("version_info_3", "request-1", "besFirmwareVersion" to "new")
        assertThat(accumulator.accept(last + (VersionInfoResponseAccumulator.RESPONSE_SID_KEY to "process-2")))
            .isEqualTo(VersionInfoAccumulatorOutcome.Ignored)
        assertThat(accumulator.accept(last)).isInstanceOf(VersionInfoAccumulatorOutcome.Complete::class.java)
    }

    @Test
    fun correlatedResponseWithoutCompletenessMetadataCannotComplete() {
        val accumulator = VersionInfoResponseAccumulator("request-1")
        val event = mapOf<String, Any>(
            VersionInfoResponseAccumulator.RESPONSE_CHUNK_KEY to "version_info_3",
            VersionInfoResponseAccumulator.RESPONSE_REQUEST_ID_KEY to "request-1",
        )
        assertThat(accumulator.accept(event)).isEqualTo(VersionInfoAccumulatorOutcome.Ignored)
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
                put(VersionInfoResponseAccumulator.RESPONSE_INDEX_KEY, if (type == "version_info_1") 1 else 2)
                put(VersionInfoResponseAccumulator.RESPONSE_COUNT_KEY, 2)
                put(VersionInfoResponseAccumulator.RESPONSE_FINAL_KEY, type == "version_info_3")
                put(VersionInfoResponseAccumulator.RESPONSE_SID_KEY, "process-1")
            }
            putAll(values)
        }
}
