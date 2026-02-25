package com.mentra.core.testing

data class StressTestResult(
  val testName: String,
  val success: Boolean,
  val durationMs: Long,
  val message: String,
  val error: String?
) {
  fun toMap(): Map<String, Any?> = mapOf(
    "testName" to testName,
    "success" to success,
    "durationMs" to durationMs,
    "message" to message,
    "error" to error
  )
}
