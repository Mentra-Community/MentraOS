package com.mentra.bluetoothsdk.photoreceiver

import android.content.Context
import com.mentra.bluetoothsdk.debug.BleTraceLogger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.nio.charset.StandardCharsets
import java.util.Locale
import java.util.UUID
import java.util.concurrent.Semaphore
import org.json.JSONObject

data class PhotoUpload(
    val requestId: String?,
    val photoFile: File,
    val byteCount: Int,
    val fields: Map<String, String>,
)

class LocalPhotoUploadServer(
    context: Context,
    private val onLog: (String) -> Unit,
    private val onUpload: (PhotoUpload) -> Unit,
) : AutoCloseable {
    private val appContext = context.applicationContext
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var serverSocket: ServerSocket? = null
    private var serverJob: Job? = null
    private val uploadDir = File(appContext.cacheDir, "mentra-photo-uploads")
    private val clientSlots = Semaphore(MAX_ACTIVE_CLIENTS)

    @Volatile
    var running: Boolean = false
        private set

    val activePort: Int?
        get() = serverSocket
            ?.takeIf { running && !it.isClosed }
            ?.localPort

    fun start(port: Int): Int {
        val activeSocket = serverSocket
        if (running && activeSocket != null && !activeSocket.isClosed && activeSocket.localPort == port) {
            onLog("Already listening on 0.0.0.0:${activeSocket.localPort}")
            return activeSocket.localPort
        }
        stop()
        uploadDir.mkdirs()
        val socket = ServerSocket()
        try {
            socket.reuseAddress = true
            socket.bind(InetSocketAddress("0.0.0.0", port))
            serverSocket = socket
            running = true
            serverJob = scope.launch {
                acceptLoop(socket)
            }
        } catch (error: Throwable) {
            try {
                socket.close()
            } catch (_: Throwable) {
            }
            throw error
        }
        onLog("Listening on 0.0.0.0:${socket.localPort}")
        return socket.localPort
    }

    fun stop() {
        running = false
        serverJob?.cancel()
        serverJob = null
        try {
            serverSocket?.close()
        } catch (_: Throwable) {
        }
        serverSocket = null
    }

    override fun close() {
        stop()
        scope.cancel()
    }

    private fun acceptLoop(socket: ServerSocket) {
        while (scope.isActive && !socket.isClosed) {
            try {
                val client = socket.accept()
                if (!clientSlots.tryAcquire()) {
                    rejectClient(client)
                    continue
                }
                scope.launch {
                    try {
                        handleClient(client)
                    } finally {
                        clientSlots.release()
                    }
                }
            } catch (error: SocketException) {
                if (running) onLog("Accept failed: ${error.message}")
            } catch (error: Throwable) {
                if (running) onLog("Accept failed: ${error.message ?: error::class.java.simpleName}")
            }
        }
    }

    private fun handleClient(socket: Socket) {
        socket.use { client ->
            val requestStartMs = System.currentTimeMillis()
            client.soTimeout = 20_000
            val input = BufferedInputStream(client.getInputStream())
            val output = client.getOutputStream()
            var request: HttpRequest? = null
            var requestId: String? = null
            var contentLength: Long? = null

            traceWifiInput(
                "photo_receiver_connection",
                client,
                requestStartMs,
                mutableMapOf(
                    "timestampMs" to requestStartMs,
                ),
            )

            fun respond(status: Int, body: String) {
                writeJson(output, status, body)
                traceWifiOutput(
                    "photo_receiver_response",
                    client,
                    requestStartMs,
                    mutableMapOf(
                        "method" to request?.method,
                        "path" to request?.path,
                        "requestId" to requestId,
                        "contentLength" to contentLength,
                        "statusCode" to status,
                        "success" to (status in 200..299),
                        "responseBytes" to body.toByteArray(StandardCharsets.UTF_8).size,
                        "durationMs" to (System.currentTimeMillis() - requestStartMs),
                    ),
                )
            }

            try {
                val headerBytes = readHeaders(input)
                val headerText = headerBytes.toString(StandardCharsets.ISO_8859_1)
                request = HttpRequest.parse(headerText)
                onLog("${request.method} ${request.path} from ${client.inetAddress.hostAddress}")
                contentLength = request.headers["content-length"]?.toLongOrNull()
                traceWifiInput(
                    "photo_receiver_request",
                    client,
                    requestStartMs,
                    mutableMapOf(
                        "method" to request.method,
                        "path" to request.path,
                        "contentType" to request.headers["content-type"].orEmpty(),
                        "contentLength" to contentLength,
                        "userAgent" to request.headers["user-agent"].orEmpty(),
                    ),
                )

                if (request.method == "GET" && (request.path == "/" || request.path == "/health")) {
                    respond(200, """{"ok":true,"service":"mentra-photo-upload-receiver"}""")
                    return
                }

                if (request.method != "POST" || request.path != "/upload") {
                    respond(404, """{"ok":false,"error":"not_found"}""")
                    return
                }

                val contentType = request.headers["content-type"].orEmpty()
                if (contentLength == null || contentLength <= 0) {
                    respond(411, """{"ok":false,"error":"content_length_required"}""")
                    return
                }
                if (contentLength > MAX_UPLOAD_BYTES) {
                    respond(413, """{"ok":false,"error":"upload_too_large"}""")
                    return
                }
                if (request.headers["expect"]?.contains("100-continue", ignoreCase = true) == true) {
                    output.write("HTTP/1.1 100 Continue\r\n\r\n".toByteArray(StandardCharsets.US_ASCII))
                    output.flush()
                }

                onLog("headers contentType=$contentType contentLength=$contentLength userAgent=${request.headers["user-agent"].orEmpty()}")
                val boundary = multipartBoundary(contentType)
                if (boundary == null) {
                    respond(400, """{"ok":false,"error":"multipart_boundary_required"}""")
                    return
                }
                val parsed = parseMultipart(ContentLengthInputStream(input, contentLength), boundary)
                val photoPart = parsed.files["photo"] ?: parsed.files.values.firstOrNull()
                if (photoPart == null) {
                    parsed.deleteFiles()
                    respond(400, """{"ok":false,"error":"photo_field_required"}""")
                    return
                }

                requestId = parsed.fields["requestId"] ?: parsed.fields["request_id"]
                val file = File(uploadDir, "${safeFilePart(requestId ?: "photo-${System.currentTimeMillis()}")}.jpg")
                try {
                    moveFile(photoPart.file, file)
                } finally {
                    parsed.deleteFilesExcept(file)
                }
                onLog("upload fields=${parsed.fields.keys.joinToString(",")} requestId=${requestId.orEmpty()} bytes=${photoPart.byteCount} saved=${file.absolutePath}")
                val upload = PhotoUpload(
                    requestId = requestId,
                    photoFile = file,
                    byteCount = photoPart.byteCount,
                    fields = parsed.fields,
                )
                traceWifiInput(
                    "photo_receiver_upload_received",
                    client,
                    requestStartMs,
                    mutableMapOf(
                        "method" to request.method,
                        "path" to request.path,
                        "requestId" to requestId,
                        "source" to parsed.fields["source"],
                        "contentLength" to contentLength,
                        "photoBytes" to photoPart.byteCount,
                        "savedFileName" to file.name,
                        "durationMs" to (System.currentTimeMillis() - requestStartMs),
                    ),
                )
                respond(200, """{"ok":true,"requestId":${jsonString(requestId.orEmpty())},"bytes":${photoPart.byteCount}}""")
                try {
                    onUpload(upload)
                } catch (callbackError: Throwable) {
                    onLog("upload callback failed: ${callbackError.message ?: callbackError::class.java.simpleName}")
                }
            } catch (error: Throwable) {
                onLog("request failed: ${error.message ?: error::class.java.simpleName}")
                traceWifiInput(
                    "photo_receiver_request_error",
                    client,
                    requestStartMs,
                    mutableMapOf(
                        "method" to request?.method,
                        "path" to request?.path,
                        "requestId" to requestId,
                        "contentLength" to contentLength,
                        "durationMs" to (System.currentTimeMillis() - requestStartMs),
                        "errorClass" to error::class.java.simpleName,
                        "errorMessage" to (error.message ?: error::class.java.simpleName),
                    ),
                )
                respond(500, """{"ok":false,"error":${jsonString(error.message ?: "server_error")}}""")
            }
        }
    }

    private fun rejectClient(socket: Socket) {
        socket.use { client ->
            try {
                writeJson(client.getOutputStream(), 503, """{"ok":false,"error":"too_many_connections"}""")
            } catch (_: Throwable) {
            }
        }
    }

    private fun readHeaders(input: InputStream): ByteArray {
        val out = ByteArrayOutputStream()
        val delimiter = byteArrayOf(13, 10, 13, 10)
        var matched = 0
        while (true) {
            val byte = input.read()
            if (byte == -1) throw EOFException("Socket closed before HTTP headers completed")
            out.write(byte)
            matched = if (byte.toByte() == delimiter[matched]) {
                matched + 1
            } else if (byte.toByte() == delimiter[0]) {
                1
            } else {
                0
            }
            if (matched == delimiter.size) return out.toByteArray()
            if (out.size() > MAX_HEADER_BYTES) throw IllegalArgumentException("HTTP headers too large")
        }
    }

    private fun writeJson(output: OutputStream, status: Int, body: String) {
        val reason = when (status) {
            200 -> "OK"
            400 -> "Bad Request"
            404 -> "Not Found"
            411 -> "Length Required"
            413 -> "Payload Too Large"
            503 -> "Service Unavailable"
            else -> "Internal Server Error"
        }
        val bytes = body.toByteArray(StandardCharsets.UTF_8)
        output.write("HTTP/1.1 $status $reason\r\n".toByteArray(StandardCharsets.US_ASCII))
        output.write("Content-Type: application/json\r\n".toByteArray(StandardCharsets.US_ASCII))
        output.write("Content-Length: ${bytes.size}\r\n".toByteArray(StandardCharsets.US_ASCII))
        output.write("Connection: close\r\n\r\n".toByteArray(StandardCharsets.US_ASCII))
        output.write(bytes)
        output.flush()
    }

    private data class HttpRequest(
        val method: String,
        val path: String,
        val headers: Map<String, String>,
    ) {
        companion object {
            fun parse(headerText: String): HttpRequest {
                val lines = headerText.split("\r\n").filter { it.isNotBlank() }
                val requestParts = lines.firstOrNull()?.split(" ").orEmpty()
                val method = requestParts.getOrNull(0)?.uppercase(Locale.US).orEmpty()
                val path = requestParts.getOrNull(1)?.substringBefore("?").orEmpty()
                val headers = lines.drop(1).mapNotNull { line ->
                    val separator = line.indexOf(':')
                    if (separator <= 0) return@mapNotNull null
                    line.substring(0, separator).lowercase(Locale.US) to line.substring(separator + 1).trim()
                }.toMap()
                return HttpRequest(method, path, headers)
            }
        }
    }

    private data class ParsedMultipart(
        val fields: Map<String, String>,
        val files: Map<String, StreamedFile>,
    ) {
        fun deleteFiles() {
            files.values.forEach { it.file.delete() }
        }

        fun deleteFilesExcept(keptFile: File) {
            files.values.forEach { part ->
                if (part.file.absolutePath != keptFile.absolutePath) {
                    part.file.delete()
                }
            }
        }
    }

    private data class StreamedFile(
        val file: File,
        val byteCount: Int,
    )

    private fun parseMultipart(input: InputStream, boundary: String): ParsedMultipart {
        val marker = "--$boundary"
        val delimiter = "\r\n$marker".toByteArray(StandardCharsets.ISO_8859_1)
        val fields = mutableMapOf<String, String>()
        val files = mutableMapOf<String, StreamedFile>()
        val tempFiles = mutableListOf<File>()

        try {
            val firstLine = readAsciiLine(input)
            if (firstLine == "$marker--") {
                return ParsedMultipart(fields = fields, files = files)
            }
            if (firstLine != marker) {
                throw IllegalArgumentException("multipart_boundary_missing")
            }

            var done = false
            while (!done) {
                val headerBlock = readPartHeaders(input)
                val disposition = headerBlock.lineSequence()
                    .firstOrNull { it.startsWith("Content-Disposition:", ignoreCase = true) }
                    .orEmpty()
                val name = Regex("""name="([^"]+)"""").find(disposition)?.groupValues?.get(1)
                val filename = Regex("""filename="([^"]*)"""").find(disposition)?.groupValues?.get(1)
                if (name == null) {
                    streamPartTo(input, delimiter, DiscardOutputStream)
                } else if (filename != null) {
                    val tempFile = File(uploadDir, "upload-${System.currentTimeMillis()}-${UUID.randomUUID()}.tmp")
                    tempFiles += tempFile
                    val byteCount = FileOutputStream(tempFile).use { fileOutput ->
                        streamPartTo(input, delimiter, fileOutput)
                    }
                    files.put(name, StreamedFile(tempFile, byteCount.toInt()))?.file?.delete()
                } else {
                    val fieldOutput = LimitedByteArrayOutputStream(MAX_FIELD_BYTES)
                    streamPartTo(input, delimiter, fieldOutput)
                    fields[name] = fieldOutput.toByteArray().toString(StandardCharsets.UTF_8).trim()
                }
                done = readBoundarySuffix(input)
            }

            return ParsedMultipart(fields = fields, files = files)
        } catch (error: Throwable) {
            tempFiles.forEach { it.delete() }
            throw error
        }
    }

    private fun readAsciiLine(input: InputStream): String {
        val out = ByteArrayOutputStream()
        while (true) {
            val byte = input.read()
            if (byte == -1) throw EOFException("Socket closed before multipart line completed")
            if (byte == '\n'.code) {
                val bytes = out.toByteArray()
                val length = if (bytes.isNotEmpty() && bytes.last() == '\r'.code.toByte()) bytes.size - 1 else bytes.size
                return String(bytes, 0, length, StandardCharsets.ISO_8859_1)
            }
            out.write(byte)
            if (out.size() > MAX_PART_HEADER_BYTES) throw IllegalArgumentException("multipart line too large")
        }
    }

    private fun readPartHeaders(input: InputStream): String {
        val out = ByteArrayOutputStream()
        val delimiter = byteArrayOf(13, 10, 13, 10)
        var matched = 0
        while (true) {
            val byte = input.read()
            if (byte == -1) throw EOFException("Socket closed before multipart headers completed")
            out.write(byte)
            matched = if (byte.toByte() == delimiter[matched]) {
                matched + 1
            } else if (byte.toByte() == delimiter[0]) {
                1
            } else {
                0
            }
            if (matched == delimiter.size) {
                val bytes = out.toByteArray()
                return String(bytes, 0, bytes.size - delimiter.size, StandardCharsets.ISO_8859_1)
            }
            if (out.size() > MAX_PART_HEADER_BYTES) throw IllegalArgumentException("multipart headers too large")
        }
    }

    private fun streamPartTo(input: InputStream, delimiter: ByteArray, output: OutputStream): Long {
        val tail = ArrayDeque<Byte>()
        var byteCount = 0L
        while (true) {
            val next = input.read()
            if (next == -1) throw EOFException("Socket closed before multipart boundary completed")
            tail.addLast(next.toByte())
            if (tail.size > delimiter.size) {
                output.write(tail.removeFirst().toInt() and 0xff)
                byteCount += 1
            }
            if (tail.size == delimiter.size && tailMatches(tail, delimiter)) {
                output.flush()
                return byteCount
            }
        }
    }

    private fun tailMatches(tail: ArrayDeque<Byte>, delimiter: ByteArray): Boolean {
        if (tail.size != delimiter.size) return false
        tail.forEachIndexed { index, byte ->
            if (byte != delimiter[index]) return false
        }
        return true
    }

    private fun readBoundarySuffix(input: InputStream): Boolean {
        val first = input.read()
        if (first == -1) throw EOFException("Socket closed after multipart boundary")
        return when (first) {
            '-'.code -> {
                val second = input.read()
                if (second != '-'.code) throw IllegalArgumentException("invalid multipart closing boundary")
                true
            }
            '\r'.code -> {
                val second = input.read()
                if (second != '\n'.code) throw IllegalArgumentException("invalid multipart boundary separator")
                false
            }
            else -> throw IllegalArgumentException("invalid multipart boundary suffix")
        }
    }

    private fun multipartBoundary(contentType: String): String? {
        return contentType.split(';')
            .map { it.trim() }
            .firstOrNull { it.startsWith("boundary=", ignoreCase = true) }
            ?.substringAfter('=')
            ?.trim()
            ?.trim('"')
            ?.takeIf { it.isNotBlank() }
    }

    private fun safeFilePart(value: String): String {
        return value.replace(Regex("[^A-Za-z0-9._-]"), "_").ifBlank { "photo" }
    }

    private fun jsonString(value: String): String {
        return JSONObject.quote(value)
    }

    private fun moveFile(source: File, destination: File) {
        if (destination.exists()) {
            destination.delete()
        }
        if (!source.renameTo(destination)) {
            source.copyTo(destination, overwrite = true)
            source.delete()
        }
    }

    private fun traceWifiInput(
        type: String,
        client: Socket,
        startMs: Long,
        values: MutableMap<String, Any?> = mutableMapOf(),
    ) {
        traceWifi("wifi_to_phone", "wifi_http_input", type, client, startMs, values)
    }

    private fun traceWifiOutput(
        type: String,
        client: Socket,
        startMs: Long,
        values: MutableMap<String, Any?> = mutableMapOf(),
    ) {
        traceWifi("phone_to_wifi", "wifi_http_output", type, client, startMs, values)
    }

    private fun traceWifi(
        direction: String,
        layer: String,
        type: String,
        client: Socket,
        startMs: Long,
        values: MutableMap<String, Any?>,
    ) {
        val payload = JSONObject()
        putJson(payload, "type", type)
        putJson(payload, "remoteHost", client.inetAddress?.hostAddress)
        putJson(payload, "remotePort", client.port)
        putJson(payload, "localHost", client.localAddress?.hostAddress)
        putJson(payload, "localPort", client.localPort)
        putJson(payload, "startMs", startMs)
        values.forEach { (key, value) -> putJson(payload, key, value) }
        try {
            BleTraceLogger.logJson(direction, layer, payload, null)
        } catch (_: Throwable) {
        }
    }

    private fun putJson(payload: JSONObject, key: String, value: Any?) {
        if (value == null) return
        try {
            payload.put(key, value)
        } catch (_: Throwable) {
        }
    }

    companion object {
        private const val MAX_HEADER_BYTES = 64 * 1024
        private const val MAX_PART_HEADER_BYTES = 64 * 1024
        private const val MAX_FIELD_BYTES = 64 * 1024
        private const val MAX_UPLOAD_BYTES = 25L * 1024L * 1024L
        private const val MAX_ACTIVE_CLIENTS = 2
    }
}

private object DiscardOutputStream : OutputStream() {
    override fun write(b: Int) {
    }
}

private class LimitedByteArrayOutputStream(
    private val maxBytes: Int,
) : ByteArrayOutputStream() {
    override fun write(b: Int) {
        if (size() + 1 > maxBytes) throw IllegalArgumentException("multipart field too large")
        super.write(b)
    }

    override fun write(b: ByteArray, off: Int, len: Int) {
        if (size() + len > maxBytes) throw IllegalArgumentException("multipart field too large")
        super.write(b, off, len)
    }
}

private class ContentLengthInputStream(
    private val input: InputStream,
    private var remainingBytes: Long,
) : InputStream() {
    override fun read(): Int {
        if (remainingBytes <= 0) return -1
        val byte = input.read()
        if (byte != -1) {
            remainingBytes -= 1
        }
        return byte
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (remainingBytes <= 0) return -1
        val readLength = minOf(length.toLong(), remainingBytes).toInt()
        val byteCount = input.read(buffer, offset, readLength)
        if (byteCount > 0) {
            remainingBytes -= byteCount.toLong()
        }
        return byteCount
    }
}
