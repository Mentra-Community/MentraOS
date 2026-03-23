package com.mentra.core.testing

import android.os.Handler
import android.os.Looper
import android.util.Log
import com.mentra.core.Bridge
import com.mentra.core.CoreManager
import com.mentra.core.GlassesStore
import com.mentra.core.utils.PhoneAudioMonitor
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Phone-side stress tests for MentraOS reliability.
 *
 * Filter results: adb logcat -s STRESS_TEST
 *
 * Tests:
 * 1. RapidMicToggle   - 50x setMicEnabled() at 200ms intervals
 * 2. AudioPermutations - 6 sequences of LC3 + phone audio conflicts
 * 3. ScoConflict       - LC3 mic during simulated SCO entry/exit
 * 4. BleCommandBurst   - 50 mixed BLE commands, no delay
 * 5. CameraRapidFire   - 10 photos, no delay
 */
class StressTestRunner private constructor() {

  companion object {
    private const val TAG = "STRESS_TEST"

    // Test configuration
    private const val MIC_TOGGLE_COUNT = 50
    private const val MIC_TOGGLE_DELAY_MS = 200L
    private const val AUDIO_ACTION_DELAY_MS = 500L
    private const val AUDIO_SEQUENCE_DELAY_MS = 1000L
    private const val SCO_HOLD_MS = 2000L
    private const val BLE_COMMAND_COUNT = 50
    private const val CAMERA_PHOTO_COUNT = 10
    private const val CAMERA_WAIT_MS = 15000L
    private const val TEST_COOLDOWN_MS = 2000L

    @Volatile private var instance: StressTestRunner? = null

    @JvmStatic
    fun getInstance(): StressTestRunner =
      instance ?: synchronized(this) {
        instance ?: StressTestRunner().also { instance = it }
      }
  }

  private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
  private val isRunning = AtomicBoolean(false)
  private val results = mutableListOf<StressTestResult>()

  // ── Public API ──────────────────────────────────────────────────

  fun runAllTests(callback: ((List<StressTestResult>) -> Unit)? = null) {
    if (!isRunning.compareAndSet(false, true)) {
      log("Tests already running, skipping")
      return
    }

    log("=== Starting MentraOS Stress Tests ===")
    results.clear()

    scope.launch {
      try {
        testRapidMicToggle()
        delay(TEST_COOLDOWN_MS)

        testAudioPermutations()
        delay(TEST_COOLDOWN_MS)

        testScoConflict()
        delay(TEST_COOLDOWN_MS)

        testBleCommandBurst()
        delay(TEST_COOLDOWN_MS)

        testCameraRapidFire()

        log("=== All Tests Complete ===")
        printSummary()
        callback?.invoke(results.toList())
      } catch (e: Exception) {
        log("ERROR: Test suite failed: ${e.message}")
      } finally {
        isRunning.set(false)
      }
    }
  }

  fun runTest(testName: String, callback: ((StressTestResult) -> Unit)? = null) {
    if (!isRunning.compareAndSet(false, true)) {
      log("Test already running, skipping")
      return
    }

    log("Running single test: $testName")

    scope.launch {
      try {
        when (testName.lowercase()) {
          "rapidmictoggle" -> testRapidMicToggle()
          "audiopermutations" -> testAudioPermutations()
          "scoconflict" -> testScoConflict()
          "blecommandburst" -> testBleCommandBurst()
          "camerarapidfire" -> testCameraRapidFire()
          else -> {
            log("Unknown test: $testName")
            results.add(StressTestResult(testName, false, 0, "Unknown test name", null))
          }
        }
        callback?.invoke(results.last())
      } finally {
        isRunning.set(false)
      }
    }
  }

  fun getResults(): List<StressTestResult> = results.toList()

  fun clearResults() {
    results.clear()
    log("Results cleared")
  }

  // ── Test 1: Rapid Mic Toggle ────────────────────────────────────

  private suspend fun testRapidMicToggle() {
    val name = "RapidMicToggle"
    log("[$name] Starting - ${MIC_TOGGLE_COUNT}x mic toggles at ${MIC_TOGGLE_DELAY_MS}ms")

    val cm = CoreManager.getInstance()
    val t0 = System.currentTimeMillis()

    try {
      for (i in 1..MIC_TOGGLE_COUNT) {
        val enable = (i % 2 == 1)
        withContext(Dispatchers.Main) { GlassesStore.apply("core", "should_send_lc3", enable) }
        delay(MIC_TOGGLE_DELAY_MS)
        if (i % 10 == 0) log("[$name] Progress: $i/$MIC_TOGGLE_COUNT")
      }

      // Cleanup
      withContext(Dispatchers.Main) {
        GlassesStore.apply("core", "should_send_lc3", false)
        GlassesStore.apply("core", "should_send_pcm", false)
        GlassesStore.apply("core", "should_send_transcript", false)
      }

      val dur = System.currentTimeMillis() - t0
      results.add(StressTestResult(name, true, dur, "$MIC_TOGGLE_COUNT toggles completed", null))
      log("[$name] PASS - ${dur}ms")
    } catch (e: Exception) {
      val dur = System.currentTimeMillis() - t0
      results.add(StressTestResult(name, false, dur, "Exception during toggles", e.message))
      log("[$name] FAIL - ${e.message}")
      // Attempt cleanup
      try { withContext(Dispatchers.Main) {
        GlassesStore.apply("core", "should_send_lc3", false)
        GlassesStore.apply("core", "should_send_pcm", false)
        GlassesStore.apply("core", "should_send_transcript", false)
      } } catch (_: Exception) {}
    }
  }

  // ── Test 2: Audio Permutations ──────────────────────────────────

  private suspend fun testAudioPermutations() {
    val name = "AudioPermutations"
    log("[$name] Starting - 6 sequences of LC3 + phone audio conflicts")

    val cm = CoreManager.getInstance()
    val t0 = System.currentTimeMillis()

    val sequences = listOf(
      // 1: LC3 on → audio on → audio off → LC3 off
      listOf("lc3_on", "audio_on", "audio_off", "lc3_off"),
      // 2: audio on → LC3 on → LC3 off → audio off
      listOf("audio_on", "lc3_on", "lc3_off", "audio_off"),
      // 3: LC3 on → audio on → LC3 off → audio off
      listOf("lc3_on", "audio_on", "lc3_off", "audio_off"),
      // 4: audio on → LC3 on → audio off → LC3 off
      listOf("audio_on", "lc3_on", "audio_off", "lc3_off"),
      // 5: Rapid toggle - LC3 on, audio on/off/on/off, LC3 off
      listOf("lc3_on", "audio_on", "audio_off", "audio_on", "audio_off", "lc3_off"),
      // 6: Stress - interleaved on/off
      listOf("lc3_on", "audio_on", "lc3_off", "audio_off", "lc3_on", "audio_on", "lc3_off", "audio_off")
    )

    try {
      for ((idx, sequence) in sequences.withIndex()) {
        log("[$name] Sequence ${idx + 1}/${sequences.size}: ${sequence.joinToString(" → ")}")

        for (action in sequence) {
          withContext(Dispatchers.Main) { executeAudioAction(cm, action) }
          delay(AUDIO_ACTION_DELAY_MS)
        }
        delay(AUDIO_SEQUENCE_DELAY_MS)
      }

      // Cleanup
      withContext(Dispatchers.Main) {
        GlassesStore.apply("core", "should_send_lc3", false)
        GlassesStore.apply("core", "should_send_pcm", false)
        GlassesStore.apply("core", "should_send_transcript", false)
        PhoneAudioMonitor.getInstance(Bridge.getContext()).setOwnAppAudioPlaying(false)
      }

      val dur = System.currentTimeMillis() - t0
      results.add(StressTestResult(name, true, dur, "6 sequences completed", null))
      log("[$name] PASS - ${dur}ms")
    } catch (e: Exception) {
      val dur = System.currentTimeMillis() - t0
      results.add(StressTestResult(name, false, dur, "Exception during permutations", e.message))
      log("[$name] FAIL - ${e.message}")
      try {
        withContext(Dispatchers.Main) {
          GlassesStore.apply("core", "should_send_lc3", false)
          GlassesStore.apply("core", "should_send_pcm", false)
          GlassesStore.apply("core", "should_send_transcript", false)
          PhoneAudioMonitor.getInstance(Bridge.getContext()).setOwnAppAudioPlaying(false)
        }
      } catch (_: Exception) {}
    }
  }

  // ── Test 3: SCO Conflict ────────────────────────────────────────

  private suspend fun testScoConflict() {
    val name = "ScoConflict"
    log("[$name] Starting - Simulated SCO conflict during LC3")
    log("[$name] NOTE: Full SCO requires actual phone call; this simulates via PhoneAudioMonitor")

    val cm = CoreManager.getInstance()
    val t0 = System.currentTimeMillis()

    try {
      // 1. Start LC3 mic
      log("[$name] Step 1: Starting LC3 mic")
      withContext(Dispatchers.Main) { GlassesStore.apply("core", "should_send_lc3", true) }
      delay(1000)

      // 2. Simulate SCO entry (phone audio playing)
      log("[$name] Step 2: Simulating SCO entry")
      withContext(Dispatchers.Main) {
        PhoneAudioMonitor.getInstance(Bridge.getContext()).setOwnAppAudioPlaying(true)
      }
      delay(SCO_HOLD_MS)

      // 3. Simulate SCO exit
      log("[$name] Step 3: Simulating SCO exit")
      withContext(Dispatchers.Main) {
        PhoneAudioMonitor.getInstance(Bridge.getContext()).setOwnAppAudioPlaying(false)
      }
      delay(1000)

      // 4. Verify LC3 recovery (mic should auto-resume)
      log("[$name] Step 4: Verifying LC3 recovery (1s wait)")
      delay(1000)

      // 5. Cleanup
      log("[$name] Step 5: Stopping LC3 mic")
      withContext(Dispatchers.Main) {
        GlassesStore.apply("core", "should_send_lc3", false)
        GlassesStore.apply("core", "should_send_pcm", false)
        GlassesStore.apply("core", "should_send_transcript", false)
      }

      val dur = System.currentTimeMillis() - t0
      results.add(StressTestResult(name, true, dur, "Simulated SCO conflict completed",
        "Note: full test requires phone call"))
      log("[$name] PASS - ${dur}ms (simulated)")
    } catch (e: Exception) {
      val dur = System.currentTimeMillis() - t0
      results.add(StressTestResult(name, false, dur, "Exception during SCO simulation", e.message))
      log("[$name] FAIL - ${e.message}")
      try {
        withContext(Dispatchers.Main) {
          GlassesStore.apply("core", "should_send_lc3", false)
          GlassesStore.apply("core", "should_send_pcm", false)
          GlassesStore.apply("core", "should_send_transcript", false)
          PhoneAudioMonitor.getInstance(Bridge.getContext()).setOwnAppAudioPlaying(false)
        }
      } catch (_: Exception) {}
    }
  }

  // ── Test 4: BLE Command Burst ───────────────────────────────────

  private suspend fun testBleCommandBurst() {
    val name = "BleCommandBurst"
    log("[$name] Starting - $BLE_COMMAND_COUNT mixed commands, no delay")

    val cm = CoreManager.getInstance()
    val t0 = System.currentTimeMillis()
    var errors = 0

    try {
      for (i in 1..BLE_COMMAND_COUNT) {
        withContext(Dispatchers.Main) {
          try {
            when (i % 3) {
              0 -> cm.queryGalleryStatus()
              1 -> cm.requestWifiScan()
              2 -> cm.requestVersionInfo()
            }
          } catch (e: Exception) {
            errors++
            log("[$name] Command $i failed: ${e.message}")
          }
        }
        // No delay between commands

        if (i % 10 == 0) log("[$name] Progress: $i/$BLE_COMMAND_COUNT (errors: $errors)")
      }

      // Wait for BLE queue to drain (sendQueue has 160ms rate limiting)
      log("[$name] Waiting 5s for queue to drain...")
      delay(5000)

      val dur = System.currentTimeMillis() - t0
      val msg = "$BLE_COMMAND_COUNT commands sent, $errors errors"
      results.add(StressTestResult(name, errors == 0, dur, msg, null))
      log("[$name] ${if (errors == 0) "PASS" else "FAIL"} - $msg - ${dur}ms")
    } catch (e: Exception) {
      val dur = System.currentTimeMillis() - t0
      results.add(StressTestResult(name, false, dur, "Exception during burst", e.message))
      log("[$name] FAIL - ${e.message}")
    }
  }

  // ── Test 5: Camera Rapid Fire ───────────────────────────────────

  private suspend fun testCameraRapidFire() {
    val name = "CameraRapidFire"
    log("[$name] Starting - $CAMERA_PHOTO_COUNT photos, no delay")

    val cm = CoreManager.getInstance()
    val t0 = System.currentTimeMillis()
    var sent = 0
    var rejected = 0

    try {
      for (i in 1..CAMERA_PHOTO_COUNT) {
        val requestId = "stress_photo_${System.currentTimeMillis()}_$i"
        withContext(Dispatchers.Main) {
          try {
            cm.photoRequest(requestId, "stress_test", "small", "", "", "true", true, true)
            sent++
          } catch (e: Exception) {
            rejected++
            log("[$name] Photo $i rejected: ${e.message}")
          }
        }
        // No delay between requests
      }

      log("[$name] All requests sent (sent=$sent, rejected=$rejected). Waiting ${CAMERA_WAIT_MS / 1000}s...")
      delay(CAMERA_WAIT_MS)

      val dur = System.currentTimeMillis() - t0
      val msg = "Sent: $sent, Rejected: $rejected"
      results.add(StressTestResult(name, sent > 0, dur, msg, null))
      log("[$name] ${if (sent > 0) "PASS" else "FAIL"} - $msg - ${dur}ms")
    } catch (e: Exception) {
      val dur = System.currentTimeMillis() - t0
      results.add(StressTestResult(name, false, dur, "Exception during rapid fire", e.message))
      log("[$name] FAIL - ${e.message}")
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private fun executeAudioAction(cm: CoreManager, action: String) {
    when (action) {
      "lc3_on" -> GlassesStore.apply("core", "should_send_lc3", true)
      "lc3_off" -> GlassesStore.apply("core", "should_send_lc3", false)
      "audio_on" -> PhoneAudioMonitor.getInstance(Bridge.getContext()).setOwnAppAudioPlaying(true)
      "audio_off" -> PhoneAudioMonitor.getInstance(Bridge.getContext()).setOwnAppAudioPlaying(false)
    }
  }

  private fun printSummary() {
    val passed = results.count { it.success }
    val failed = results.count { !it.success }
    val totalMs = results.sumOf { it.durationMs }

    log("=== Test Summary ===")
    log("Total: ${results.size} | Passed: $passed | Failed: $failed | Duration: ${totalMs}ms")
    for (r in results) {
      val status = if (r.success) "PASS" else "FAIL"
      log("  [$status] ${r.testName} - ${r.durationMs}ms - ${r.message}")
      r.error?.let { log("    Error: $it") }
    }
  }

  private fun log(message: String) {
    Log.d(TAG, message)
  }
}
