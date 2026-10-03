package com.mentra.framepreview

import android.content.Context
import android.util.Log
import java.io.BufferedWriter
import java.io.File
import java.io.FileWriter
import java.util.concurrent.Executors
import org.json.JSONObject

/**
 * Append-only NDJSON record of one preview run.
 *
 * The 1 Hz counters already existed, but they only ever lived on a screen for one second each,
 * which makes "is render slower than pack_only" an argument rather than a diff. One line per
 * second, tagged with a run id and the device's identity, turns the experiment into something
 * two people can compare after the fact.
 *
 * The file goes under `getExternalFilesDir` so it can be pulled with `adb pull` and no root.
 * Writes are serialized on a single thread and flushed every line: a soak that ends in a crash
 * or a thermal shutdown is exactly the run whose tail matters most.
 */
class PreviewRunLog {
  private val executor = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "frame-preview-runlog").apply { isDaemon = true }
  }

  @Volatile
  var path: String? = null
    private set

  @Volatile
  var runId: String = ""
    private set

  private var writer: BufferedWriter? = null

  /**
   * Records written before the file exists.
   *
   * The interesting lifecycle events — the document being prepared, the consumer
   * authenticating — all happen while the page is connecting, which is before `start()` opens
   * the file. Dropping them would leave every run's log beginning after the only part that
   * explains how it got there. Bounded, because a preview that never starts must not grow.
   */
  private val pending = mutableListOf<Map<String, Any?>>()

  /**
   * Open a file for [runId] and write the `meta` line that every later line is interpreted
   * against: device, OS, mode, target fps, and anything else the caller considers fixed.
   */
  fun begin(context: Context, runId: String, meta: Map<String, Any?>) {
    executor.execute {
      closeWriter()
      this.runId = runId
      try {
        val directory = File(context.getExternalFilesDir(null) ?: context.filesDir, DIRECTORY)
        directory.mkdirs()
        val file = File(directory, "$runId.ndjson")
        writer = BufferedWriter(FileWriter(file, true))
        path = file.absolutePath
        Log.i(TAG, "run log ${file.absolutePath}")
        append(meta + mapOf("t" to "meta", "runId" to runId))
        // Replay what happened while the page was connecting, tagged with this run so the file
        // is self-contained.
        val replay = pending.toList()
        pending.clear()
        for (earlier in replay) append(earlier + mapOf("runId" to runId, "beforeStart" to true))
      } catch (error: Throwable) {
        // A run without a log file is still a valid run. Say so once and carry on.
        Log.w(TAG, "run log unavailable", error)
        writer = null
        path = null
      }
    }
  }

  fun write(record: Map<String, Any?>) {
    executor.execute {
      if (writer == null) {
        if (pending.size < PENDING_LIMIT) pending.add(record)
        return@execute
      }
      append(record)
    }
  }

  fun end(reason: String, summary: Map<String, Any?> = emptyMap()) {
    executor.execute {
      if (writer == null) return@execute
      append(summary + mapOf("t" to "end", "runId" to runId, "reason" to reason))
      closeWriter()
      pending.clear()
    }
  }

  private fun append(record: Map<String, Any?>) {
    val target = writer ?: return
    try {
      target.write(JSONObject(sanitize(record)).toString())
      target.newLine()
      // Flushed per line on purpose: the tail of a run that ended badly is the interesting part.
      target.flush()
    } catch (error: Throwable) {
      Log.w(TAG, "run log write failed", error)
    }
  }

  private fun closeWriter() {
    try {
      writer?.flush()
      writer?.close()
    } catch (error: Throwable) {
      Log.w(TAG, "run log close failed", error)
    }
    writer = null
  }

  /**
   * `JSONObject` turns a non-finite double into a thrown exception, and a rate computed over a
   * zero-length window is exactly that. Replacing them keeps the other twenty counters on the line.
   */
  private fun sanitize(record: Map<String, Any?>): Map<String, Any?> = record.mapValues { (_, value) ->
    when (value) {
      is Double -> if (value.isFinite()) value else 0.0
      is Float -> if (value.isFinite()) value.toDouble() else 0.0
      else -> value
    }
  }

  private companion object {
    const val TAG = "FRAME-PREVIEW"
    const val DIRECTORY = "frame-preview"
    const val PENDING_LIMIT = 64
  }
}
