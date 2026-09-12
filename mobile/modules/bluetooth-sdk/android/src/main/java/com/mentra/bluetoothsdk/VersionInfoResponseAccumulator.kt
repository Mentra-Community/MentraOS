package com.mentra.bluetoothsdk

internal sealed interface VersionInfoAccumulatorOutcome {
    data object Ignored : VersionInfoAccumulatorOutcome
    data object Waiting : VersionInfoAccumulatorOutcome
    data class Complete(val result: VersionInfoResult) : VersionInfoAccumulatorOutcome
}

/** One request, explicit modern completion, or the deployed legacy chunk-3 terminal boundary. */
internal class VersionInfoResponseAccumulator(private val expectedRequestId: String) {
    private val values = mutableMapOf<String, Any>()
    private val chunks = mutableMapOf<Int, Map<String, Any>>()
    private var count: Int? = null
    private var sid: String? = null
    private var legacyStarted = false
    private var completed = false

    fun accept(event: Map<String, Any>): VersionInfoAccumulatorOutcome {
        if (completed) return VersionInfoAccumulatorOutcome.Ignored
        val hasModernMetadata = event.keys.any { it in MODERN_KEYS }
        if (hasModernMetadata) {
            if (event[RESPONSE_REQUEST_ID_KEY] != expectedRequestId) return VersionInfoAccumulatorOutcome.Ignored
            val index = integer(event[RESPONSE_INDEX_KEY]) ?: return VersionInfoAccumulatorOutcome.Ignored
            val total = integer(event[RESPONSE_COUNT_KEY]) ?: return VersionInfoAccumulatorOutcome.Ignored
            val final = event[RESPONSE_FINAL_KEY] as? Boolean ?: return VersionInfoAccumulatorOutcome.Ignored
            val process = (event[RESPONSE_SID_KEY] as? String)?.takeIf { it.isNotBlank() }
                ?: return VersionInfoAccumulatorOutcome.Ignored
            if (total !in 1..16 || index !in 1..total || final != (index == total)) return VersionInfoAccumulatorOutcome.Ignored
            if (count != null && (count != total || sid != process)) return VersionInfoAccumulatorOutcome.Ignored
            if (count == null) {
                values.clear()
                count = total
                sid = process
            }
            chunks[index] = event
            if (chunks.size != total) return VersionInfoAccumulatorOutcome.Waiting
            (1..total).forEach { merge(chunks.getValue(it)) }
            return finish()
        }
        // Once a response is correlated, unsolicited legacy traffic cannot replace it.
        if (count != null) return VersionInfoAccumulatorOutcome.Ignored
        when (event[RESPONSE_CHUNK_KEY] as? String ?: "version_info") {
            "version_info" -> { values.clear(); merge(event); return finish() }
            "version_info_1" -> { values.clear(); legacyStarted = true; merge(event) }
            "version_info_2" -> {
                if (!legacyStarted) return VersionInfoAccumulatorOutcome.Ignored
                merge(event)
            }
            "version_info_3" -> {
                if (!legacyStarted) return VersionInfoAccumulatorOutcome.Ignored
                merge(event)
                return finish()
            }
            else -> return VersionInfoAccumulatorOutcome.Ignored
        }
        // Silence is never evidence of completion. The request's normal deadline handles loss.
        return VersionInfoAccumulatorOutcome.Waiting
    }

    private fun finish(): VersionInfoAccumulatorOutcome.Complete {
        completed = true
        return VersionInfoAccumulatorOutcome.Complete(VersionInfoResult.fromMap(values))
    }

    private fun merge(event: Map<String, Any>) {
        event.forEach { (key, value) ->
            if (!key.startsWith("_response") && key != "type" && (value !is String || value.isNotEmpty())) {
                values[key] = value
            }
        }
    }

    private fun integer(value: Any?): Int? {
        val number = value as? Number ?: return null
        val int = number.toInt()
        return int.takeIf { number.toDouble() == it.toDouble() }
    }

    companion object {
        internal const val RESPONSE_CHUNK_KEY = "_responseChunk"
        internal const val RESPONSE_REQUEST_ID_KEY = "_responseRequestId"
        internal const val RESPONSE_INDEX_KEY = "_responseChunkIndex"
        internal const val RESPONSE_COUNT_KEY = "_responseChunkCount"
        internal const val RESPONSE_FINAL_KEY = "_responseFinal"
        internal const val RESPONSE_SID_KEY = "_responseSid"
        private val MODERN_KEYS = setOf(RESPONSE_REQUEST_ID_KEY, RESPONSE_INDEX_KEY, RESPONSE_COUNT_KEY, RESPONSE_FINAL_KEY)
    }
}
