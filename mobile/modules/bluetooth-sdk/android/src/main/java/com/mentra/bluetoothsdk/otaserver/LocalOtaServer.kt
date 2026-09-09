package com.mentra.bluetoothsdk.otaserver

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
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.nio.charset.StandardCharsets
import java.util.Locale
import java.util.concurrent.Semaphore
import org.json.JSONObject

/**
 * Static HTTP server for hotspot-served glasses OTA (OS-1676).
 *
 * Serves the rewritten OTA manifest at /version.json and pre-downloaded artifacts at
 * /artifacts/<sha256> to the glasses over the glasses-hotspot link. Same hand-rolled
 * socket structure as [LocalPhotoUploadServer] —
 * no third-party HTTP dependency in the SDK.
 */
class LocalOtaServer(
    private val onLog: (String) -> Unit,
) : AutoCloseable {
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var serverSocket: ServerSocket? = null
    private var serverJob: Job? = null
    private val clientSlots = Semaphore(MAX_ACTIVE_CLIENTS)

    @Volatile
    private var manifestJson: String = "{}"

    @Volatile
    private var artifacts: Map<String, File> = emptyMap()

    @Volatile
    var running: Boolean = false
        private set

    val activePort: Int?
        get() = serverSocket
            ?.takeIf { running && !it.isClosed }
            ?.localPort

    /** Swap the served manifest and artifact set. Safe while the server is running. */
    fun configure(manifestJson: String, artifacts: Map<String, File>) {
        this.manifestJson = manifestJson
        this.artifacts = artifacts
    }

    fun start(host: String, port: Int): Int {
        val activeSocket = serverSocket
        if (running && activeSocket != null && !activeSocket.isClosed && activeSocket.localPort == port) {
            onLog("Already listening on $host:${activeSocket.localPort}")
            return activeSocket.localPort
        }
        stop()
        val socket = ServerSocket()
        try {
            socket.reuseAddress = true
            socket.bind(InetSocketAddress(host, port))
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
        onLog("OTA server listening on $host:${socket.localPort}")
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
            client.soTimeout = SOCKET_TIMEOUT_MS
            val input = BufferedInputStream(client.getInputStream())
            val output = client.getOutputStream()
            var request: HttpRequest? = null
            var status = 0
            var responseBytes = 0L

            try {
                val headerText = readHeaders(input).toString(StandardCharsets.ISO_8859_1)
                request = HttpRequest.parse(headerText)
                onLog("${request.method} ${request.path} from ${client.inetAddress.hostAddress}")

                if (request.method != "GET") {
                    status = 405
                    writeJson(output, status, """{"ok":false,"error":"method_not_allowed"}""")
                    return
                }

                when {
                    request.path == "/version.json" -> {
                        val body = manifestJson.toByteArray(StandardCharsets.UTF_8)
                        status = 200
                        responseBytes = body.size.toLong()
                        writeBody(output, status, "application/json", body)
                    }
                    request.path.startsWith("/artifacts/") -> {
                        val key = request.path.removePrefix("/artifacts/")
                        val file = artifacts[key]
                        if (file == null || !file.isFile) {
                            status = 404
                            writeJson(output, status, """{"ok":false,"error":"artifact_not_found"}""")
                        } else {
                            status = 200
                            responseBytes = file.length()
                            writeFile(output, file)
                        }
                    }
                    else -> {
                        status = 404
                        writeJson(output, status, """{"ok":false,"error":"not_found"}""")
                    }
                }
            } catch (error: Throwable) {
                onLog("request failed: ${error.message ?: error::class.java.simpleName}")
                if (status == 0) {
                    status = 500
                    try {
                        writeJson(output, status, """{"ok":false,"error":"server_error"}""")
                    } catch (_: Throwable) {
                    }
                }
            } finally {
                trace(client, request, status, responseBytes, requestStartMs)
            }
        }
    }

    private fun writeFile(output: OutputStream, file: File) {
        val fileLength = file.length()
        output.write("HTTP/1.1 200 OK\r\n".toByteArray(StandardCharsets.US_ASCII))
        output.write("Content-Type: application/octet-stream\r\n".toByteArray(StandardCharsets.US_ASCII))
        output.write("Content-Length: $fileLength\r\n".toByteArray(StandardCharsets.US_ASCII))
        output.write("Connection: close\r\n\r\n".toByteArray(StandardCharsets.US_ASCII))
        file.inputStream().use { fileInput ->
            val buffer = ByteArray(STREAM_CHUNK_BYTES)
            var remaining = fileLength
            while (remaining > 0) {
                val read = fileInput.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
                if (read <= 0) throw EOFException("artifact truncated while streaming")
                output.write(buffer, 0, read)
                remaining -= read
            }
        }
        output.flush()
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
        writeBody(output, status, "application/json", body.toByteArray(StandardCharsets.UTF_8))
    }

    private fun writeBody(
        output: OutputStream,
        status: Int,
        contentType: String,
        body: ByteArray,
    ) {
        val reason = when (status) {
            200 -> "OK"
            404 -> "Not Found"
            405 -> "Method Not Allowed"
            503 -> "Service Unavailable"
            else -> "Internal Server Error"
        }
        output.write("HTTP/1.1 $status $reason\r\n".toByteArray(StandardCharsets.US_ASCII))
        output.write("Content-Type: $contentType\r\n".toByteArray(StandardCharsets.US_ASCII))
        output.write("Content-Length: ${body.size}\r\n".toByteArray(StandardCharsets.US_ASCII))
        output.write("Connection: close\r\n\r\n".toByteArray(StandardCharsets.US_ASCII))
        output.write(body)
        output.flush()
    }

    private fun trace(
        client: Socket,
        request: HttpRequest?,
        status: Int,
        responseBytes: Long,
        startMs: Long,
    ) {
        val payload = JSONObject()
        try {
            payload.put("type", "ota_server_request")
            payload.put("remoteHost", client.inetAddress?.hostAddress ?: "")
            payload.put("method", request?.method ?: "")
            payload.put("path", request?.path ?: "")
            payload.put("statusCode", status)
            payload.put("responseBytes", responseBytes)
            payload.put("durationMs", System.currentTimeMillis() - startMs)
            BleTraceLogger.logJson("phone_to_wifi", "wifi_http_output", payload, null)
        } catch (_: Throwable) {
        }
    }

    private data class HttpRequest(
        val method: String,
        val path: String,
    ) {
        companion object {
            fun parse(headerText: String): HttpRequest {
                val lines = headerText.split("\r\n").filter { it.isNotBlank() }
                val requestParts = lines.firstOrNull()?.split(" ").orEmpty()
                val method = requestParts.getOrNull(0)?.uppercase(Locale.US).orEmpty()
                val path = requestParts.getOrNull(1)?.substringBefore("?").orEmpty()
                return HttpRequest(method, path)
            }
        }
    }

    companion object {
        private const val MAX_HEADER_BYTES = 64 * 1024
        private const val MAX_ACTIVE_CLIENTS = 2
        private const val SOCKET_TIMEOUT_MS = 20_000
        private const val STREAM_CHUNK_BYTES = 64 * 1024
    }
}
