package com.mentra.bluetoothsdk.sgcs

import java.io.ByteArrayOutputStream

// ---------- Even File Service (service 0xC4 cmd / 0xC5 data) ----------

/**
 * The glasses' generic file-push channel, and how notification content gets across: the body is a
 * JSON document pushed as a file. Unlike every other G2 service this is **not** protobuf —
 * SEND_START is a fixed 93-byte struct and the data phase writes raw bytes.
 *
 * Each phase is acked with a 2-byte `[cid][status]`:
 *   START(fileType, length, crc32, filename) → ack → DATA → raw bytes on 0xC5 → ack
 *     → RESULT_CHECK → ack
 */
internal object FileService {
    // eEvenFileSendServiceCID — first byte of every 0xC4 payload
    const val CID_SEND_START = 0
    const val CID_SEND_DATA = 1
    const val CID_SEND_RESULT_CHECK = 2

    const val TYPE_ANDROID_MSG_JSON_NOTIFICATION = 1

    // Notification bodies and the whitelist share this path: the firmware has one filename
    // constant (`BleG2GlassesFilePath.notifyWhitelist`) and discriminates on `fileType`.
    const val PATH_NOTIFY = "user/notify_whitelist.json"

    const val FILENAME_FIELD_LEN = 80
    const val SEND_START_LEN = 93 // 1 + 4 + 4 + 4 + 80

    // eEvenFileServiceRsp
    fun statusName(status: Int): String =
        when (status) {
            0 -> "SUCCESS"
            1 -> "START_ERR"
            2 -> "DATA_CRC_ERR"
            3 -> "FLASH_WRITE_ERR"
            4 -> "TIMEOUT"
            5 -> "NO_RESOURCES"
            6 -> "RESULT_CHECK_FAIL"
            7 -> "FAIL"
            8 -> "CANCEL"
            else -> "status_$status"
        }

    private fun ByteArrayOutputStream.writeU32LE(value: Int) {
        write(value and 0xFF)
        write((value ushr 8) and 0xFF)
        write((value ushr 16) and 0xFF)
        write((value ushr 24) and 0xFF)
    }

    /** 93-byte fixed struct: cid | fileType u32 | fileLength u32 | fileCrc32 u32 | filename[80]. */
    fun sendStart(fileType: Int, fileLength: Int, fileCrc32: Int, filename: String): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(CID_SEND_START)
        out.writeU32LE(fileType)
        out.writeU32LE(fileLength)
        out.writeU32LE(fileCrc32)

        val nameBytes = filename.toByteArray(Charsets.US_ASCII)
        require(nameBytes.size < FILENAME_FIELD_LEN) { "filename too long: $filename" }
        out.write(nameBytes)
        repeat(FILENAME_FIELD_LEN - nameBytes.size) { out.write(0) } // NUL-padded to 80

        return out.toByteArray().also { check(it.size == SEND_START_LEN) }
    }

    fun sendData(): ByteArray = byteArrayOf(CID_SEND_DATA.toByte())

    fun resultCheck(): ByteArray = byteArrayOf(CID_SEND_RESULT_CHECK.toByte())
}

// ---------- Notification payload JSON ----------

/**
 * The JSON document the glasses expect on the file service — these nine fields, exactly. Schema
 * confirmed against a BLE capture of the Even app; see `notes/g2-notification-service.md`.
 *
 * `time_s` is UTC epoch seconds while `date` is **device-local** wall time; formatting `date` in
 * UTC would skew every displayed timestamp by the device's offset.
 */
internal object NotificationJson {
    fun androidNotification(
        msgId: Int,
        action: Int,
        appIdentifier: String,
        title: String,
        subtitle: String,
        message: String,
        postTimeMs: Long,
        displayName: String
    ): ByteArray {
        val dateFmt = java.text.SimpleDateFormat("yyyyMMdd'T'HHmmss", java.util.Locale.US)
        val body =
            org.json.JSONObject()
                .put("msg_id", msgId)
                .put("action", action)
                .put("app_identifier", appIdentifier)
                .put("title", title)
                .put("subtitle", subtitle)
                .put("message", message)
                .put("time_s", postTimeMs / 1000)
                .put("date", dateFmt.format(java.util.Date(postTimeMs)))
                .put("display_name", displayName)

        return org.json.JSONObject()
            .put("android_notification", body)
            .toString()
            .toByteArray(Charsets.UTF_8)
    }
}

