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
    fun `streams a full artifact`() {
        val connection = open("/artifacts/$sha")
        assertThat(connection.responseCode).isEqualTo(200)
        assertThat(connection.inputStream.readBytes()).isEqualTo(artifactBytes)
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
