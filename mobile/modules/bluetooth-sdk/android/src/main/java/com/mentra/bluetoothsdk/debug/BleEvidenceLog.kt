package com.mentra.bluetoothsdk.debug

import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONArray
import org.json.JSONObject

/**
 * Bounded provenance record for Mentra Live battery and Wi-Fi scan observations (schema v1).
 *
 * The record lets a device test prove that a value shown by the app came from a specific
 * glasses notification on a specific, still-current BLE connection. It is not telemetry:
 * it stores only lifecycle boundaries, battery percentages, scan request/send/chunk/terminal
 * metadata and allowlisted render markers, in a fixed-size in-memory ring. Nothing is uploaded.
 *
 * Identities are derived from one random [streamId] per process plus a strictly increasing
 * [Record.seq]:
 * - a connection is the seq of its `connection_accepted` record (nonreused within the stream,
 *   and a manager recreated in the same process still gets a new seq);
 * - a wire epoch is the seq of the latest `wire_reset` (or the connection record itself);
 * - a BLE write generation is the seq of the `ble_generation` record naming the send-queue
 *   generation that each queued write captured when it was queued;
 * - a logical event id is `"<streamId>:<seq>"` of its `battery`/`scan_chunk` record.
 *
 * SSIDs are never stored or serialized. A scan chunk keeps SHA-256 digests of up to
 * [MAX_SCAN_SSIDS] of its SSIDs in memory so a snapshot can report only whether a
 * caller-supplied target digest was present. A target that is not among the retained digests
 * is reported as absent only when every network of the chunk was retained; otherwise unknown.
 *
 * Read access is [dump], reached through `dumpsys` on the non-exported foreground service
 * (DUMP permission, shell/system only). It is read-only and runs on the owner looper so its
 * fence is ordered after every callback that already ran there.
 */
object BleEvidenceLog {
    const val SCHEMA_VERSION = 1
    const val CAPACITY = 512
    const val DUMP_COMMAND = "mentra-ble-evidence"
    const val OUTPUT_PREFIX = "MENTRA_BLE_EVIDENCE "
    const val SURFACE_BATTERY = "glasses_battery"
    const val SURFACE_WIFI_SCAN = "wifi_scan"
    private const val MAX_SCAN_SSIDS = 64
    private const val MAX_RENDER_EVENT_IDS = 32
    private const val DUMP_TIMEOUT_MS = 2_000L
    private val SHA256_HEX = Regex("^[0-9a-f]{64}$")

    /** Receive origin captured at the accepted notification, before decoding. */
    data class Origin(val connection: Long, val wire: Long)

    private class Record(
        val seq: Long,
        val elapsedRealtimeMs: Long,
        val kind: String,
        val fields: Map<String, Any?>,
        /** SSID digest -> exact requiresPassword boolean (null when not a boolean). Never serialized. */
        val ssidSecurity: Map<String, Boolean?>? = null,
        /** False when some network of the chunk was not retained in [ssidSecurity]. */
        val ssidCoverageComplete: Boolean = true,
        /**
         * False when some entry of the chunk could not be identified (unparsed or without a
         * string SSID); such an entry could repeat a seen target with another security value.
         */
        val ssidSecurityCertain: Boolean = true,
    )

    private val lock = Any()
    private val records = ArrayDeque<Record>()
    @Volatile var streamId: String = UUID.randomUUID().toString()
        private set
    private var lastSeq = 0L
    private var droppedCount = 0L
    private var currentConnection = 0L
    private var currentPeerMac: String? = null
    private var currentWire = 0L
    private var currentWriteGeneration = 0L
    internal var clock: () -> Long = { SystemClock.elapsedRealtime() }

    /** Starts a new stream as a fresh process would. Tests only. */
    internal fun resetForTest() {
        synchronized(lock) {
            records.clear()
            streamId = UUID.randomUUID().toString()
            lastSeq = 0L
            droppedCount = 0L
            currentConnection = 0L
            currentPeerMac = null
            currentWire = 0L
            currentWriteGeneration = 0L
        }
    }

    fun eventId(seq: Long): String = "$streamId:$seq"

    /** Records an accepted connection for the actual callback peer and returns its origin. */
    fun connectionAccepted(peerMac: String): Origin =
        synchronized(lock) {
            val seq = append("connection_accepted", mapOf("peerMac" to peerMac))
            currentConnection = seq
            currentPeerMac = peerMac
            currentWire = seq
            Origin(seq, seq)
        }

    fun connectionClosed(connection: Long, reason: String) {
        if (connection == 0L) return
        synchronized(lock) {
            append("connection_closed", mapOf("connection" to connection, "reason" to reason))
            if (currentConnection == connection) {
                currentConnection = 0L
                currentPeerMac = null
                currentWire = 0L
            }
        }
    }

    /** Wire negotiation reset without a BLE disconnect (e.g. glasses_ready). Returns the new wire epoch. */
    fun wireReset(connection: Long): Long =
        synchronized(lock) {
            val seq = append("wire_reset", mapOf("connection" to connection))
            if (connection == currentConnection) currentWire = seq
            seq
        }

    /**
     * The BLE send queue moved to [generation] (manager creation or disconnect reset). Writes
     * queued under an older generation are never transmitted. Returns the boundary seq that
     * queued writes of this generation reference as `writeGeneration`.
     */
    fun bleGeneration(connection: Long, generation: Long): Long =
        synchronized(lock) {
            val seq =
                append(
                    "ble_generation",
                    mapOf("connection" to (if (connection == 0L) null else connection), "generation" to generation),
                )
            currentWriteGeneration = seq
            seq
        }

    fun receiveRejected(reason: String, origin: Origin?) {
        synchronized(lock) {
            append("receive_rejected", mapOf("reason" to reason, "origin" to originJson(origin)))
        }
    }

    /**
     * Records a battery value decoded from one notification. [pmuCharging] is only for the
     * PMU `charg` bit of `sr_hrt`; percent-only sources pass null.
     */
    fun battery(origin: Origin?, percent: Int, source: String, pmuCharging: Boolean?): String =
        synchronized(lock) {
            val fields = linkedMapOf<String, Any?>(
                "origin" to originJson(origin),
                "percent" to percent,
                "source" to source,
            )
            if (pmuCharging != null) fields["pmuCharging"] = pmuCharging
            eventId(append("battery", fields))
        }

    fun scanRequest(scanId: String, fresh: Boolean) {
        synchronized(lock) {
            append("scan_request", mapOf("scanId" to scanId, "mode" to if (fresh) "fresh" else "joined"))
        }
    }

    /**
     * One native write of a scan command. Outcomes: queued, not_queued, gatt_accepted,
     * gatt_refused, write_ok, write_failed, stale_dropped. [connection] and [writeGeneration]
     * are the values captured when the write was queued, never re-read later.
     */
    fun scanSend(
        scanId: String,
        outcome: String,
        fragment: Int,
        fragments: Int,
        connection: Long,
        writeGeneration: Long?,
    ) {
        synchronized(lock) {
            append(
                "scan_send",
                mapOf(
                    "scanId" to scanId,
                    "outcome" to outcome,
                    "fragment" to fragment,
                    "fragments" to fragments,
                    "connection" to (if (connection == 0L) null else connection),
                    "writeGeneration" to writeGeneration,
                ),
            )
        }
    }

    /**
     * [networks] are the entries the decoder parsed. [entriesParsed] is false when the raw chunk
     * had entries (or a network list) that could not be parsed; they were not delivered either,
     * so a target among them is unknown rather than absent.
     */
    fun scanChunk(
        origin: Origin?,
        scanId: String?,
        networks: List<Map<String, Any>>,
        complete: Boolean,
        entriesParsed: Boolean,
    ): String {
        val security = LinkedHashMap<String, Boolean?>()
        var identitiesKnown = entriesParsed
        var coverageComplete = entriesParsed
        for (network in networks) {
            // An entry without a string SSID could be anything: coverage is no longer complete.
            val ssid = network["ssid"] as? String
            if (ssid == null) {
                identitiesKnown = false
                coverageComplete = false
                continue
            }
            val digest = sha256Hex(ssid)
            val requiresPassword = network["requiresPassword"] as? Boolean
            if (security.containsKey(digest)) {
                // Conflicting duplicates make the security value unknown.
                if (security[digest] != requiresPassword) security[digest] = null
                continue
            }
            if (security.size >= MAX_SCAN_SSIDS) {
                coverageComplete = false
                continue
            }
            security[digest] = requiresPassword
        }
        return synchronized(lock) {
            val seq =
                append(
                    "scan_chunk",
                    mapOf(
                        "origin" to originJson(origin),
                        "scanId" to scanId,
                        "networks" to networks.size,
                        "entriesParsed" to entriesParsed,
                        "complete" to complete,
                    ),
                    security,
                    coverageComplete,
                    identitiesKnown,
                )
            eventId(seq)
        }
    }

    /** Result: complete, timeout_partial, timeout_empty, error, legacy_uncorrelated. */
    fun scanTerminal(scanId: String?, result: String, networks: Int) {
        synchronized(lock) {
            append("scan_terminal", mapOf("scanId" to scanId, "result" to result, "networks" to networks))
        }
    }

    fun bridgeDispatch(eventId: String, type: String, sinks: Int) {
        synchronized(lock) {
            append("bridge_dispatch", mapOf("eventId" to eventId, "type" to type, "sinks" to sinks))
        }
    }

    /**
     * Records that app UI committed state derived from [eventIds]. Only allowlisted surfaces and
     * bounded integer values are accepted; ids from another stream are counted, not stored.
     */
    fun uiRender(surface: String, eventIds: List<String>, value: Int?): Boolean {
        val maxValue =
            when (surface) {
                SURFACE_BATTERY -> 100
                SURFACE_WIFI_SCAN -> 500
                else -> return false
            }
        if (value != null && (value < 0 || value > maxValue)) return false
        return synchronized(lock) {
            val prefix = "$streamId:"
            val accepted = eventIds.filter { id ->
                id.startsWith(prefix) &&
                    id.substring(prefix.length).toLongOrNull()?.let { it in 1..lastSeq } == true
            }.distinct()
            append(
                "ui_render",
                mapOf(
                    "surface" to surface,
                    "eventIds" to JSONArray(accepted.take(MAX_RENDER_EVENT_IDS)),
                    "rejectedEventIds" to (eventIds.size - accepted.size),
                    "truncated" to (accepted.size > MAX_RENDER_EVENT_IDS),
                    "value" to value,
                ),
            )
            true
        }
    }

    /**
     * Returns every retained record after [afterSeq]. `outcome` is `ok` only when the cursor
     * belongs to this stream and no record after it was evicted.
     */
    fun snapshot(afterSeq: Long?, targetSha256: String?): JSONObject =
        synchronized(lock) {
            val firstRetained = records.firstOrNull()?.seq ?: (lastSeq + 1)
            val target = targetSha256?.lowercase()
            val outcome =
                when {
                    afterSeq == null || afterSeq < 0 -> "invalid_request"
                    target != null && !SHA256_HEX.matches(target) -> "invalid_request"
                    afterSeq > lastSeq -> "stale_cursor"
                    afterSeq < firstRetained - 1 -> "gap"
                    else -> "ok"
                }
            val out = JSONObject()
            out.put("schemaVersion", SCHEMA_VERSION)
            out.put("streamId", streamId)
            out.put("pid", Process.myPid())
            out.put("outcome", outcome)
            out.put("afterSeq", afterSeq ?: JSONObject.NULL)
            out.put("fenceSeq", lastSeq)
            out.put("firstRetainedSeq", firstRetained)
            out.put("droppedCount", droppedCount)
            out.put("nowElapsedRealtimeMs", clock())
            out.put("targetFiltered", target != null && outcome != "invalid_request")
            out.put(
                "current",
                JSONObject().apply {
                    put("connection", if (currentConnection == 0L) JSONObject.NULL else currentConnection)
                    put("peerMac", currentPeerMac ?: JSONObject.NULL)
                    put("wire", if (currentWire == 0L) JSONObject.NULL else currentWire)
                    put("writeGeneration", if (currentWriteGeneration == 0L) JSONObject.NULL else currentWriteGeneration)
                },
            )
            val list = JSONArray()
            if (outcome != "invalid_request" && outcome != "stale_cursor") {
                for (record in records) {
                    if (record.seq > afterSeq!!) list.put(recordJson(record, target))
                }
            }
            out.put("records", list)
            out
        }

    /**
     * Handles `dumpsys ... mentra-ble-evidence afterSeq=<n> [targetSha256=<hex>]`. Returns null
     * for any other dump request. The snapshot runs on [owner] so it is ordered after work that
     * already ran there; if the owner does not answer in time the outcome is `unavailable`.
     */
    fun dump(args: Array<out String>?, owner: Handler, timeoutMs: Long = DUMP_TIMEOUT_MS): String? {
        if (args.isNullOrEmpty() || args[0] != DUMP_COMMAND) return null
        var afterSeq: Long? = null
        var target: String? = null
        var valid = true
        for (arg in args.drop(1)) {
            when {
                arg.startsWith("afterSeq=") -> afterSeq = arg.removePrefix("afterSeq=").toLongOrNull()
                arg.startsWith("targetSha256=") -> target = arg.removePrefix("targetSha256=")
                else -> valid = false
            }
        }
        if (!valid) afterSeq = null
        val result = AtomicReference<JSONObject?>()
        if (Looper.myLooper() == owner.looper) {
            result.set(snapshot(afterSeq, target))
        } else {
            val done = CountDownLatch(1)
            val posted =
                owner.post {
                    result.set(snapshot(afterSeq, target))
                    done.countDown()
                }
            if (posted) done.await(timeoutMs, TimeUnit.MILLISECONDS)
        }
        val snapshot =
            result.get()
                ?: JSONObject().apply {
                    put("schemaVersion", SCHEMA_VERSION)
                    put("streamId", streamId)
                    put("pid", Process.myPid())
                    put("outcome", "unavailable")
                }
        return OUTPUT_PREFIX + snapshot
    }

    fun sha256Hex(value: String): String =
        MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray(StandardCharsets.UTF_8))
            .joinToString("") { "%02x".format(it) }

    private fun append(
        kind: String,
        fields: Map<String, Any?>,
        ssidSecurity: Map<String, Boolean?>? = null,
        ssidCoverageComplete: Boolean = true,
        ssidSecurityCertain: Boolean = true,
    ): Long {
        val seq = ++lastSeq
        records.addLast(Record(seq, clock(), kind, fields, ssidSecurity, ssidCoverageComplete, ssidSecurityCertain))
        while (records.size > CAPACITY) {
            records.removeFirst()
            droppedCount++
        }
        return seq
    }

    private fun originJson(origin: Origin?): Any =
        origin?.let { JSONObject().put("connection", it.connection).put("wire", it.wire) } ?: JSONObject.NULL

    private fun recordJson(record: Record, target: String?): JSONObject {
        val json = JSONObject()
        json.put("seq", record.seq)
        json.put("elapsedRealtimeMs", record.elapsedRealtimeMs)
        json.put("kind", record.kind)
        for ((key, value) in record.fields) json.put(key, value ?: JSONObject.NULL)
        val security = record.ssidSecurity
        if (security != null && target != null) {
            val seen = security.containsKey(target)
            json.put("targetCoverage", if (record.ssidCoverageComplete) "complete" else "incomplete")
            when {
                seen -> {
                    json.put("targetSeen", true)
                    // Presence is certain; its security is only certain when no entry was unidentified.
                    val requiresPassword = if (record.ssidSecurityCertain) security[target] else null
                    json.put("targetRequiresPassword", requiresPassword ?: JSONObject.NULL)
                }
                // Absence is only known when every network of the chunk was retained.
                record.ssidCoverageComplete -> json.put("targetSeen", false)
                else -> json.put("targetSeen", JSONObject.NULL)
            }
        }
        return json
    }
}
