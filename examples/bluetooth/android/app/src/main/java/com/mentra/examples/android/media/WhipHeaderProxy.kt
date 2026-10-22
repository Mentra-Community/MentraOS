package com.mentra.examples.android.media

import java.io.ByteArrayOutputStream
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.Locale
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

class WhipHeaderProxy(private val onLog: (String) -> Unit) : AutoCloseable {
    private var serverSocket: ServerSocket? = null
    private var acceptThread: Thread? = null
    private var workers: ExecutorService? = null
    private var backendPort: Int = 0

    fun start(listenPort: Int, backendPort: Int) {
        stop()
        this.backendPort = backendPort
        val server = ServerSocket(listenPort)
        server.reuseAddress = true
        val executor = Executors.newCachedThreadPool()
        serverSocket = server
        workers = executor
        acceptThread = thread(name = "whip-header-proxy", isDaemon = true) {
            onLog("WHIP proxy ready on :$listenPort -> 127.0.0.1:$backendPort")
            while (!server.isClosed) {
                try {
                    val client = server.accept()
                    executor.execute {
                        try {
                            handleClient(client)
                        } catch (error: Exception) {
                            onLog("WHIP proxy request failed: ${error.message}")
                            try {
                                client.close()
                            } catch (_: Exception) {
                            }
                        }
                    }
                } catch (error: Exception) {
                    if (!server.isClosed) {
                        onLog("WHIP proxy accept failed: ${error.message}")
                    }
                }
            }
        }
    }

    fun stop() {
        try {
            serverSocket?.close()
        } catch (_: Exception) {
        }
        serverSocket = null
        workers?.shutdownNow()
        workers?.awaitTermination(500, TimeUnit.MILLISECONDS)
        workers = null
        acceptThread = null
    }

    override fun close() {
        stop()
    }

    private fun handleClient(client: Socket) {
        client.use { clientSocket ->
            clientSocket.soTimeout = 10_000
            val input = clientSocket.getInputStream()
            val headerBytes = readHeader(input)
            if (headerBytes.isEmpty()) return

            val headerText = headerBytes.toString(Charsets.ISO_8859_1)
            val lines = headerText.split("\r\n")
            val requestLine = lines.firstOrNull().orEmpty()
            val pieces = requestLine.split(" ")
            if (pieces.size < 2) return

            val method = pieces[0]
            val path = pieces[1]
            val headers = lines.drop(1)
                .filter { it.contains(":") }
                .map {
                    val index = it.indexOf(':')
                    it.substring(0, index).trim() to it.substring(index + 1).trim()
                }
            val contentLength = headers.firstOrNull { it.first.equals("Content-Length", true) }
                ?.second
                ?.toIntOrNull() ?: 0
            val body = readExactly(input, contentLength)
            val normalizedContentType = normalizedContentType(method, headers)

            onLog("$method $path -> http://127.0.0.1:$backendPort$path")
            Socket("127.0.0.1", backendPort).use { backend ->
                backend.soTimeout = 10_000
                val backendOut = backend.getOutputStream()
                val rewritten = buildString {
                    append(method).append(' ').append(path).append(" HTTP/1.1\r\n")
                    append("Host: 127.0.0.1:").append(backendPort).append("\r\n")
                    append("Connection: close\r\n")
                    if (normalizedContentType != null) {
                        append("Content-Type: ").append(normalizedContentType).append("\r\n")
                    }
                    if (body.isNotEmpty()) {
                        append("Content-Length: ").append(body.size).append("\r\n")
                    }
                    headers.forEach { (name, value) ->
                        val lower = name.lowercase(Locale.US)
                        if (lower !in strippedRequestHeaders) {
                            append(name).append(": ").append(value).append("\r\n")
                        }
                    }
                    append("\r\n")
                }.toByteArray(Charsets.ISO_8859_1)
                backendOut.write(rewritten)
                backendOut.write(body)
                backendOut.flush()

                val response = readResponse(backend.getInputStream())
                onLog("$method $path <- ${response.statusLine} (${response.body.size} bytes)")
                clientSocket.getOutputStream().write(response.toByteArray())
            }
        }
    }

    private fun normalizedContentType(method: String, headers: List<Pair<String, String>>): String? {
        val existing = headers.firstOrNull { it.first.equals("Content-Type", true) }?.second
        return when (method.uppercase(Locale.US)) {
            "POST" -> "application/sdp"
            "PATCH" -> "application/trickle-ice-sdpfrag"
            else -> existing
        }
    }

    private fun readHeader(input: java.io.InputStream): ByteArray {
        val output = ByteArrayOutputStream()
        val marker = byteArrayOf('\r'.code.toByte(), '\n'.code.toByte(), '\r'.code.toByte(), '\n'.code.toByte())
        while (true) {
            val value = input.read()
            if (value == -1) break
            output.write(value)
            val bytes = output.toByteArray()
            if (bytes.size >= marker.size && bytes.takeLast(marker.size).toByteArray().contentEquals(marker)) {
                break
            }
        }
        return output.toByteArray()
    }

    private fun readExactly(input: java.io.InputStream, length: Int): ByteArray {
        if (length <= 0) return ByteArray(0)
        val body = ByteArray(length)
        var offset = 0
        while (offset < length) {
            val read = input.read(body, offset, length - offset)
            if (read == -1) break
            offset += read
        }
        return if (offset == length) body else body.copyOf(offset)
    }

    private fun readResponse(input: java.io.InputStream): HttpResponse {
        val headerBytes = readHeader(input)
        if (headerBytes.isEmpty()) {
            throw SocketTimeoutException("Backend WHIP response did not include HTTP headers")
        }

        val headerText = headerBytes.toString(Charsets.ISO_8859_1)
        val lines = headerText.split("\r\n")
        val statusLine = lines.firstOrNull().orEmpty()
        val headers = lines.drop(1)
            .filter { it.contains(":") }
            .map {
                val index = it.indexOf(':')
                it.substring(0, index).trim() to it.substring(index + 1).trim()
            }

        val contentLength = headers.firstOrNull { it.first.equals("Content-Length", true) }
            ?.second
            ?.toIntOrNull()
        val isChunked = headers.any {
            it.first.equals("Transfer-Encoding", true) &&
                it.second.lowercase(Locale.US).contains("chunked")
        }

        val body = when {
            contentLength != null -> readExactly(input, contentLength)
            isChunked -> readChunkedBody(input)
            else -> ByteArray(0)
        }

        return HttpResponse(headerBytes, statusLine, body)
    }

    private fun readChunkedBody(input: java.io.InputStream): ByteArray {
        val output = ByteArrayOutputStream()
        while (true) {
            val line = readLine(input)
            if (line.isEmpty()) {
                break
            }
            output.write(line.toByteArray(Charsets.ISO_8859_1))
            output.write('\r'.code)
            output.write('\n'.code)

            val chunkSize = line.substringBefore(';').trim().toIntOrNull(16) ?: 0
            if (chunkSize == 0) {
                output.write('\r'.code)
                output.write('\n'.code)
                break
            }

            output.write(readExactly(input, chunkSize))
            output.write(readExactly(input, 2))
        }
        return output.toByteArray()
    }

    private fun readLine(input: java.io.InputStream): String {
        val output = ByteArrayOutputStream()
        var previous = -1
        while (true) {
            val value = input.read()
            if (value == -1) break
            if (previous == '\r'.code && value == '\n'.code) {
                break
            }
            if (previous != -1) {
                output.write(previous)
            }
            previous = value
        }
        return output.toString(Charsets.ISO_8859_1.name())
    }

    private data class HttpResponse(
        val headerBytes: ByteArray,
        val statusLine: String,
        val body: ByteArray,
    ) {
        fun toByteArray(): ByteArray {
            val output = ByteArrayOutputStream(headerBytes.size + body.size)
            output.write(headerBytes)
            output.write(body)
            return output.toByteArray()
        }
    }

    private companion object {
        val strippedRequestHeaders = setOf(
            "host",
            "connection",
            "content-type",
            "content-length",
            "transfer-encoding",
        )
    }
}
