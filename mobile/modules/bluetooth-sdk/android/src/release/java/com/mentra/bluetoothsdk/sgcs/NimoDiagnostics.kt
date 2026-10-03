package com.mentra.bluetoothsdk.sgcs

import android.content.Context
import android.os.Handler

/** No diagnostic receiver, commands, or screen capture in release builds. */
@Suppress("UNUSED_PARAMETER")
internal class NimoDiagnostics(
  context: Context,
  handler: Handler,
  send: (ByteArray, () -> Unit) -> Boolean,
  requestCanvasHold: ((() -> Unit) -> Unit) = { _ -> },
  releaseCanvasHold: (resume: Boolean) -> Unit = { _ -> },
) {
  fun connected(maxWriteBytes: Int) {}
  fun disconnected() {}
  fun close() {}
  fun onPacket(packet: ByteArray): Boolean = false
  fun cancelHeldCapture(reason: String, resumeCanvas: Boolean = false) {}
}
