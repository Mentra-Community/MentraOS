package com.mentra.bluetoothsdk.utils

import android.os.Process
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

/** Collects a bounded snapshot of this app process's native Android logcat. */
internal object AndroidLogcatCollector {
    private const val MAX_LINES = 4_000
    private const val MAX_MESSAGE_CHARS = 16_384
    private const val MAX_TOTAL_MESSAGE_CHARS = 2_000_000
    private const val PROCESS_TIMEOUT_SECONDS = 5L

    private val epochLine =
        Regex("""^\s*(\d+(?:\.\d+)?)\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.+?)\s*:\s?(.*)$""")
    private val sensitiveMessage =
        Regex("""\b(token|password|secret|authorization|auth|bearer|key|api[_-]?key)\b""", RegexOption.IGNORE_CASE)

    fun collectCurrentProcess(): List<Map<String, Any>> {
        val process =
            ProcessBuilder(logcatCommand(Process.myPid()))
                .redirectErrorStream(true)
                .start()

        val entries = ArrayDeque<Map<String, Any>>()
        var totalMessageChars = 0
        val readerError = AtomicReference<Throwable?>()
        val readerThread =
            thread(name = "mentra-logcat-reader") {
                try {
                    process.inputStream.bufferedReader().useLines { lines ->
                        lines.mapNotNull(::parseEpochLine).take(MAX_LINES).forEach { entry ->
                            entries.addLast(entry)
                            totalMessageChars += (entry["message"] as String).length
                            while (totalMessageChars > MAX_TOTAL_MESSAGE_CHARS && entries.size > 1) {
                                totalMessageChars -= (entries.removeFirst()["message"] as String).length
                            }
                        }
                    }
                } catch (error: Throwable) {
                    readerError.set(error)
                }
            }

        if (!process.waitFor(PROCESS_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
            process.destroyForcibly()
            readerThread.join(1_000)
            throw IllegalStateException("Timed out while collecting Android logcat")
        }
        readerThread.join(1_000)
        if (readerThread.isAlive) {
            process.destroyForcibly()
            throw IllegalStateException("Timed out while reading Android logcat")
        }
        readerError.get()?.let { throw IllegalStateException("Failed to read Android logcat", it) }
        if (process.exitValue() != 0) {
            throw IllegalStateException("Android logcat exited with status ${process.exitValue()}")
        }
        return entries.toList()
    }

    internal fun parseEpochLine(line: String): Map<String, Any>? {
        val match = epochLine.matchEntire(line) ?: return null
        val (epochSeconds, pid, tid, priority, tag, rawMessage) = match.destructured
        val timestamp = epochSeconds.toBigDecimalOrNull()?.movePointRight(3)?.toLong() ?: return null
        val message =
            if (sensitiveMessage.containsMatchIn(rawMessage)) {
                "[REDACTED]"
            } else {
                rawMessage.take(MAX_MESSAGE_CHARS)
            }
        return mapOf(
            "timestamp" to timestamp,
            "level" to priority.toLogLevel(),
            "message" to message,
            "source" to "android-logcat",
            "metadata" to
                mapOf(
                    "tag" to tag.trim(),
                    "pid" to pid.toInt(),
                    "tid" to tid.toInt(),
                    "priority" to priority,
                ),
        )
    }

    internal fun logcatCommand(pid: Int): List<String> =
        listOf(
            "logcat",
            "--pid=$pid",
            "-d",
            "-v",
            "epoch",
            "-t",
            MAX_LINES.toString(),
            "*:D",
        )

    private fun String.toLogLevel(): String =
        when (this) {
            "V", "D" -> "debug"
            "I" -> "info"
            "W" -> "warn"
            else -> "error"
        }
}
