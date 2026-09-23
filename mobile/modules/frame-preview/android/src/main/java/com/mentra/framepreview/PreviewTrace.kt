package com.mentra.framepreview

import android.os.SystemClock

/**
 * Native side of the `PREVIEW_TRACE` lifecycle log.
 *
 * Every line is `[PREVIEW_TRACE] previewTraceId=… phase=… t=… key=value…`, the same shape the
 * host and SDK use, so one grep for a trace id reconstructs a preview across layers. Lines go to
 * logcat and to [sink], which the module forwards to JS so they land in bug-report logs.
 *
 * Lifecycle only: nothing here is called per frame. Repeatable warnings go through [warnLimited],
 * which logs the first occurrence and then one count per 10 s window.
 */
class PreviewTrace(
  private val sink: (level: Level, line: String) -> Unit,
  private val clockMs: () -> Long = { SystemClock.elapsedRealtime() },
) {
  enum class Level(val wire: String) { INFO("info"), WARN("warn") }

  @Volatile var traceId: String = ""

  /** Correlation ids stamped on every line when set. */
  @Volatile var docGen: Int? = null

  @Volatile var tapGeneration: Long? = null

  private val limiter = PreviewRateLimiter()

  fun info(phase: String, fields: Map<String, Any?> = emptyMap()) = emit(Level.INFO, phase, fields)

  fun warn(phase: String, fields: Map<String, Any?> = emptyMap()) = emit(Level.WARN, phase, fields)

  /** Warn once, then at most once per window with the number of repeats suppressed. */
  fun warnLimited(key: String, phase: String, fields: Map<String, Any?> = emptyMap()) {
    val suppressed = limiter.check(key, clockMs()) ?: return
    emit(Level.WARN, phase, if (suppressed > 0) fields + ("suppressed" to suppressed) else fields)
  }

  /** Emit pending suppressed counts whose window has closed. Called from the 1 Hz tick. */
  fun flushLimited() {
    for ((key, count) in limiter.flush(clockMs())) {
      emit(Level.WARN, "repeated_warning", mapOf("key" to key, "suppressed" to count))
    }
  }

  private fun emit(level: Level, phase: String, fields: Map<String, Any?>) {
    val ids = linkedMapOf<String, Any?>()
    docGen?.let { ids["docGen"] = it }
    tapGeneration?.let { ids["gen"] = it }
    val line = format(traceId, phase, clockMs(), ids + fields)
    try {
      sink(level, line)
    } catch (ignored: Throwable) {
      // A logging failure must not change what the preview does.
    }
  }

  companion object {
    /** Grep marker. Never build this by concatenation — a single grep must be exhaustive. */
    const val MARKER = "PREVIEW_TRACE"

    private const val REDACTED = "<redacted>"

    /** Keys whose values never reach the log, matched case-insensitively as substrings. */
    private val SENSITIVE_KEYS = listOf("token", "secret", "password", "credential", "authorization", "meetingurl")

    fun format(traceId: String, phase: String, tMs: Long, fields: Map<String, Any?>): String {
      val builder = StringBuilder("[").append(MARKER).append("]")
      if (traceId.isNotEmpty()) builder.append(" previewTraceId=").append(traceId)
      builder.append(" phase=").append(phase).append(" t=").append(tMs)
      for ((key, value) in fields) {
        if (value == null) continue
        builder.append(' ').append(key).append('=').append(render(sanitize(key, value)))
      }
      return builder.toString()
    }

    fun sanitize(key: String, value: Any): Any {
      val lower = key.lowercase()
      if (SENSITIVE_KEYS.any { lower.contains(it) }) return REDACTED
      return if (value is String) stripUrlSecrets(value) else value
    }

    /** Drop `?query`, `#fragment` and `user:pass@` from anything URL-shaped. */
    fun stripUrlSecrets(text: String): String {
      val scheme = text.indexOf("://")
      if (scheme < 0) return text
      var result = text
      val query = result.indexOf('?')
      if (query >= 0) result = result.substring(0, query) + "?" + REDACTED
      val fragment = result.indexOf('#')
      if (fragment >= 0) result = result.substring(0, fragment)
      val at = result.indexOf('@', scheme + 3)
      if (at >= 0) result = result.substring(0, scheme + 3) + REDACTED + "@" + result.substring(at + 1)
      return result
    }

    private fun render(value: Any): String {
      val text = when (value) {
        is Map<*, *> -> value.entries.joinToString(",", "{", "}") { "${it.key}:${it.value}" }
        else -> value.toString()
      }
      return if (text.any { it.isWhitespace() || it == '"' }) "\"" + text.replace("\"", "'") + "\"" else text
    }
  }
}

/** First occurrence passes, repeats inside a 10 s window are counted and reported once. */
class PreviewRateLimiter(private val windowMs: Long = 10_000) {
  private class Entry(var windowStartMs: Long, var suppressed: Int)

  private val entries = HashMap<String, Entry>()

  /** Suppressed count to report with this occurrence (0 for the first), or null to stay quiet. */
  @Synchronized
  fun check(key: String, nowMs: Long): Int? {
    val entry = entries[key]
    if (entry == null) {
      entries[key] = Entry(nowMs, 0)
      return 0
    }
    if (nowMs - entry.windowStartMs < windowMs) {
      entry.suppressed += 1
      return null
    }
    val suppressed = entry.suppressed
    entry.windowStartMs = nowMs
    entry.suppressed = 0
    return suppressed
  }

  /** Counts for windows that closed with repeats nobody has reported yet. */
  @Synchronized
  fun flush(nowMs: Long): List<Pair<String, Int>> {
    val due = mutableListOf<Pair<String, Int>>()
    for ((key, entry) in entries) {
      if (entry.suppressed > 0 && nowMs - entry.windowStartMs >= windowMs) {
        due += key to entry.suppressed
        entry.windowStartMs = nowMs
        entry.suppressed = 0
      }
    }
    return due
  }
}
