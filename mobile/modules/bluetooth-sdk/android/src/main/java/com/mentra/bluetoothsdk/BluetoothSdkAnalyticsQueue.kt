package com.mentra.bluetoothsdk

import org.json.JSONObject
import java.io.File

/**
 * Bounded on-disk retry queue for analytics payloads whose upload failed.
 * One JSON object per line. Oldest entries are dropped past [maxEntries]; entries
 * older than [maxAgeMillis] are discarded on drain. Every payload carries its own
 * `uuid` and `timestamp`, so a retried event neither double counts nor moves in time.
 *
 * Not thread-safe by itself: callers serialize access on the analytics executor.
 */
internal class BluetoothSdkAnalyticsQueue(
    private val file: File,
    private val maxEntries: Int = DEFAULT_MAX_ENTRIES,
    private val maxAgeMillis: Long = DEFAULT_MAX_AGE_MILLIS,
) {
    fun enqueue(payload: JSONObject, nowMillis: Long) {
        val entries = read().toMutableList()
        entries += JSONObject().put("enqueued_at", nowMillis).put("payload", payload)
        while (entries.size > maxEntries) entries.removeAt(0)
        write(entries)
    }

    fun size(): Int = read().size

    /**
     * Sends queued payloads oldest-first through [send] and keeps the ones that still
     * fail. Stops at the first failure so ordering is preserved and a dead network does
     * not burn through every entry.
     */
    fun drain(nowMillis: Long, send: (JSONObject) -> Boolean) {
        val entries = read()
        if (entries.isEmpty()) return
        val remaining = mutableListOf<JSONObject>()
        var blocked = false
        for (entry in entries) {
            val enqueuedAt = entry.optLong("enqueued_at", nowMillis)
            if (nowMillis - enqueuedAt > maxAgeMillis) continue
            val payload = entry.optJSONObject("payload") ?: continue
            if (blocked) {
                remaining += entry
                continue
            }
            val sent =
                try {
                    send(payload)
                } catch (_: Exception) {
                    false
                }
            if (!sent) {
                blocked = true
                remaining += entry
            }
        }
        write(remaining)
    }

    private fun read(): List<JSONObject> {
        if (!file.exists()) return emptyList()
        return try {
            file.readLines().mapNotNull { line ->
                line.takeIf { it.isNotBlank() }?.let { runCatching { JSONObject(it) }.getOrNull() }
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun write(entries: List<JSONObject>) {
        try {
            if (entries.isEmpty()) {
                file.delete()
                return
            }
            file.parentFile?.mkdirs()
            val tmp = File(file.parentFile, file.name + ".tmp")
            tmp.writeText(entries.joinToString("\n") { it.toString() } + "\n")
            if (!tmp.renameTo(file)) {
                file.writeText(entries.joinToString("\n") { it.toString() } + "\n")
                tmp.delete()
            }
        } catch (_: Exception) {
            // A queue write failure only loses retries, never live behavior.
        }
    }

    companion object {
        const val DEFAULT_MAX_ENTRIES = 100
        const val DEFAULT_MAX_AGE_MILLIS = 7L * 24 * 60 * 60 * 1000
        const val FILE_NAME = "mentra_bluetooth_sdk_analytics_queue.jsonl"
    }
}
