package com.mentra.bluetoothsdk.otaserver

import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import org.assertj.core.api.Assertions.assertThat
import org.junit.After
import org.junit.Before
import org.junit.Test

class LocalOtaServerTest {
    private lateinit var server: LocalOtaServer
    private lateinit var artifactFile: File
    private var port = 0

    private val manifest = """{"apps":{"com.mentra.asg_client":{"versionCode":1}}}"""
    private val artifactBytes = ByteArray(1024) { (it % 251).toByte() }
    private val sha = "a".repeat(64)

    @Before
    fun startServer() {
        artifactFile = File.createTempFile("ota-artifact", ".bin").apply {
            writeBytes(artifactBytes)
        }
        server = LocalOtaServer(onLog = {})
        server.configure(manifest, mapOf(sha to artifactFile))
        port = server.start("127.0.0.1", 0)
    }

    @After
    fun stopServer() {
        server.close()
        artifactFile.delete()
    }

    @Test
    fun `serves the configured manifest`() {
        val connection = open("/version.json")
        assertThat(connection.responseCode).isEqualTo(200)
        assertThat(connection.contentType).isEqualTo("application/json")
        assertThat(connection.inputStream.readBytes().decodeToString()).isEqualTo(manifest)
    }

    @Test
    fun `answers manifest HEAD probes`() {
        val connection = open("/version.json")
        connection.requestMethod = "HEAD"
        assertThat(connection.responseCode).isEqualTo(200)
        assertThat(connection.contentLengthLong)
            .isEqualTo(manifest.toByteArray().size.toLong())
        assertThat(connection.inputStream.readBytes()).isEmpty()
    }

    @Test
    fun `streams a full artifact`() {
        val connection = open("/artifacts/$sha")
        assertThat(connection.responseCode).isEqualTo(200)
        assertThat(connection.getHeaderField("Accept-Ranges")).isEqualTo("bytes")
        assertThat(connection.inputStream.readBytes()).isEqualTo(artifactBytes)
    }

    @Test
    fun `serves a byte range`() {
        val connection = open("/artifacts/$sha")
        connection.setRequestProperty("Range", "bytes=100-199")
        assertThat(connection.responseCode).isEqualTo(206)
        assertThat(connection.getHeaderField("Content-Range"))
            .isEqualTo("bytes 100-199/${artifactBytes.size}")
        assertThat(connection.inputStream.readBytes())
            .isEqualTo(artifactBytes.copyOfRange(100, 200))
    }

    @Test
    fun `serves a suffix range`() {
        val connection = open("/artifacts/$sha")
        connection.setRequestProperty("Range", "bytes=-16")
        assertThat(connection.responseCode).isEqualTo(206)
        assertThat(connection.inputStream.readBytes())
            .isEqualTo(artifactBytes.copyOfRange(artifactBytes.size - 16, artifactBytes.size))
    }

    @Test
    fun `serves an open-ended range`() {
        val connection = open("/artifacts/$sha")
        connection.setRequestProperty("Range", "bytes=1000-")
        assertThat(connection.responseCode).isEqualTo(206)
        assertThat(connection.inputStream.readBytes())
            .isEqualTo(artifactBytes.copyOfRange(1000, artifactBytes.size))
    }

    @Test
    fun `rejects an unsatisfiable range`() {
        val connection = open("/artifacts/$sha")
        connection.setRequestProperty("Range", "bytes=${artifactBytes.size}-")
        assertThat(connection.responseCode).isEqualTo(416)
    }

    @Test
    fun `returns 404 for unknown artifacts`() {
        val connection = open("/artifacts/${"b".repeat(64)}")
        assertThat(connection.responseCode).isEqualTo(404)
    }

    @Test
    fun `rejects non-GET methods`() {
        val connection = open("/version.json")
        connection.requestMethod = "POST"
        connection.doOutput = true
        connection.outputStream.use { it.write("{}".toByteArray()) }
        assertThat(connection.responseCode).isEqualTo(405)
    }

    @Test
    fun `reports health`() {
        val connection = open("/health")
        assertThat(connection.responseCode).isEqualTo(200)
        assertThat(connection.inputStream.readBytes().decodeToString()).contains("mentra-ota-server")
    }

    @Test
    fun `reconfigures while running`() {
        server.configure("""{"updated":true}""", emptyMap())
        val manifestConnection = open("/version.json")
        assertThat(manifestConnection.inputStream.readBytes().decodeToString())
            .isEqualTo("""{"updated":true}""")
        val artifactConnection = open("/artifacts/$sha")
        assertThat(artifactConnection.responseCode).isEqualTo(404)
    }

    private fun open(path: String): HttpURLConnection {
        val connection = URL("http://127.0.0.1:$port$path").openConnection() as HttpURLConnection
        connection.connectTimeout = 5_000
        connection.readTimeout = 5_000
        return connection
    }
}
