package com.mentra.bluetoothsdk

internal sealed interface VersionInfoAccumulatorOutcome {
    data object Ignored : VersionInfoAccumulatorOutcome

    data class Waiting(val allowQuietPeriod: Boolean) : VersionInfoAccumulatorOutcome

    data class Complete(val result: VersionInfoResult) : VersionInfoAccumulatorOutcome
}

/**
 * Collects one version-info response without combining adjacent unsolicited or stale responses.
 *
 * Current Mentra Live firmware sends `version_info_1` followed by `version_info_3`. A new chunk 1
 * always starts a fresh response, while later chunks are ignored until that boundary is observed.
 * New firmware also echoes the request id, which gives exact correlation; the chunk boundary keeps
 * the same request compatible with older firmware that does not echo it.
 */
internal class VersionInfoResponseAccumulator(
    private val expectedRequestId: String,
) {
    private val values = mutableMapOf<String, Any>()
    private var started = false
    private var startedRequestId: String? = null

    fun accept(event: Map<String, Any>): VersionInfoAccumulatorOutcome {
        val responseRequestId = event[RESPONSE_REQUEST_ID_KEY] as? String
        if (!responseRequestId.isNullOrEmpty() && responseRequestId != expectedRequestId) {
            return VersionInfoAccumulatorOutcome.Ignored
        }
        val isCorrelated = responseRequestId == expectedRequestId

        val chunk = event[RESPONSE_CHUNK_KEY] as? String ?: LEGACY_CHUNK
        if (chunk == LEGACY_CHUNK) {
            return VersionInfoAccumulatorOutcome.Complete(VersionInfoResult.fromMap(event))
        }
        if (!chunk.startsWith(CHUNK_PREFIX)) {
            return VersionInfoAccumulatorOutcome.Ignored
        }

        if (chunk == FIRST_CHUNK) {
            values.clear()
            started = true
            startedRequestId = responseRequestId
        } else if (!started) {
            // A trailing chunk can be left in the BLE queue from a boot-time or timed-out response.
            return VersionInfoAccumulatorOutcome.Ignored
        } else if (responseRequestId != startedRequestId) {
            // Never combine an uncorrelated fallback sequence with a request-id-bearing sequence.
            return VersionInfoAccumulatorOutcome.Ignored
        }

        mergeNonEmptyFields(event)
        val result = VersionInfoResult.fromMap(values)
        return if (chunk == FINAL_CHUNK && isCorrelated) {
            VersionInfoAccumulatorOutcome.Complete(result)
        } else {
            VersionInfoAccumulatorOutcome.Waiting(allowQuietPeriod = !isCorrelated)
        }
    }

    fun finishAfterQuietPeriod(): VersionInfoResult? =
        if (started && startedRequestId == null) VersionInfoResult.fromMap(values) else null

    private fun mergeNonEmptyFields(event: Map<String, Any>) {
        event.forEach { (key, value) ->
            if (key == RESPONSE_CHUNK_KEY || key == RESPONSE_REQUEST_ID_KEY || key == "type") {
                return@forEach
            }
            if (value !is String || value.isNotEmpty()) {
                values[key] = value
            }
        }
    }

    companion object {
        internal const val RESPONSE_CHUNK_KEY = "_responseChunk"
        internal const val RESPONSE_REQUEST_ID_KEY = "_responseRequestId"
        private const val LEGACY_CHUNK = "version_info"
        private const val CHUNK_PREFIX = "version_info_"
        private const val FIRST_CHUNK = "version_info_1"
        private const val FINAL_CHUNK = "version_info_3"
    }
}
