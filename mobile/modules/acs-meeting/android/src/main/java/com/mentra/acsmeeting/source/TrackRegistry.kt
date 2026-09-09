package com.mentra.acsmeeting.source

/**
 * Dedupe WebRTC track attachments by native track id.
 * Three observer callbacks can deliver distinct Java wrappers of one track;
 * object identity cannot be used. [reset] is load-bearing: [CloudflareWhepSource.start]
 * calls stop first, and a stale claim set makes reconnect never attach a sink.
 */
class TrackRegistry {
  private val ids = mutableSetOf<String>()
  private var skipped = 0

  @Synchronized
  fun claim(id: String): Boolean {
    if (ids.add(id)) return true
    skipped += 1
    return false
  }

  @Synchronized
  fun reset() {
    ids.clear()
    skipped = 0
  }

  @Synchronized
  fun size(): Int = ids.size

  @Synchronized
  fun skipped(): Int = skipped
}
