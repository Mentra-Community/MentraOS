package com.mentra.acsmeeting

import java.util.concurrent.Future
import java.util.concurrent.TimeUnit

/**
 * Recover a [com.azure.android.communication.calling.CallAgent] from a `createCallAgent` Future
 * that we stopped waiting on.
 *
 * ACS still finishes signing in after the wait is abandoned. Cancelling that Future drops the only
 * Java handle, so the next join dies with "an instance of CallAgent associated with this identity
 * already exists". Take the completed value — never cancel — and dispose it.
 */
internal object AbandonedCallAgent {
  fun <T> takeIfDone(pending: Future<T>): T? {
    if (!pending.isDone) return null
    return runCatching { pending.get() }.getOrNull()
  }

  fun <T> take(pending: Future<T>, waitMs: Long): T? {
    if (waitMs <= 0L) return takeIfDone(pending)
    return runCatching { pending.get(waitMs, TimeUnit.MILLISECONDS) }.getOrNull()
  }

  fun isExistingAgentError(error: Throwable): Boolean {
    var current: Throwable? = error
    while (current != null) {
      val message = current.message.orEmpty()
      if (message.contains("CallAgent associated with this identity already exists", ignoreCase = true)) {
        return true
      }
      current = current.cause
    }
    return false
  }
}
