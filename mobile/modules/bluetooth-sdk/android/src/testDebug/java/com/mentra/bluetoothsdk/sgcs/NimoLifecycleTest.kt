package com.mentra.bluetoothsdk.sgcs

import android.content.BroadcastReceiver
import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import com.mentra.bluetoothsdk.Bridge
import com.mentra.bluetoothsdk.DeviceManager
import com.mentra.bluetoothsdk.DeviceStore
import com.mentra.bluetoothsdk.utils.ConnTypes
import java.io.File
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
@LooperMode(LooperMode.Mode.PAUSED)
class NimoLifecycleTest {
  private class TrackingContext(base: Context) : ContextWrapper(base) {
    val unregisterLoopers = mutableListOf<Looper?>()
    val preferenceLoopers = mutableListOf<Looper?>()
    override fun getApplicationContext(): Context = this
    override fun getSharedPreferences(name: String, mode: Int): SharedPreferences {
      if (name == "NimoPrefs") preferenceLoopers.add(Looper.myLooper())
      return super.getSharedPreferences(name, mode)
    }
    override fun unregisterReceiver(receiver: BroadcastReceiver) {
      unregisterLoopers.add(Looper.myLooper())
      super.unregisterReceiver(receiver)
    }
  }

  private lateinit var context: TrackingContext
  private lateinit var nimo: Nimo
  private lateinit var encoderThread: Thread
  private lateinit var manager: DeviceManager
  private var previousManager: DeviceManager? = null
  private lateinit var diagnostics: NimoDiagnostics
  private lateinit var captureDirectory: File
  private lateinit var writeCompleted: () -> Unit
  private var writes = 0
  private val storeLoopers = mutableListOf<Looper?>()
  private var listener: String? = null

  @Before fun setup() {
    context = TrackingContext(ApplicationProvider.getApplicationContext())
    Bridge.initialize(context)
    manager = DeviceManager(initializeHardware = false)
    DeviceManager::class.java.getDeclaredField("_instance").apply { isAccessible = true }.let {
      previousManager = it.get(null) as DeviceManager?
      it.set(null, manager)
    }
    val threadsBefore = Thread.getAllStackTraces().keys
    nimo = Nimo()
    encoderThread = Thread.getAllStackTraces().keys.single {
      it.name == "NimoCanvasEncoder" && it !in threadsBefore
    }
    context.getSharedPreferences("NimoPrefs", Context.MODE_PRIVATE).edit()
      .putString("nimo_lastDeviceAddress", "00:11:22:33:44:55")
      .putString("nimo_lastDeviceName", "Nimo-test")
      .commit()
    DeviceStore.set("glasses", "connected", true)
    DeviceStore.set("glasses", "fullyBooted", true)
    DeviceStore.set("glasses", "connectionState", ConnTypes.CONNECTED)
    listener = DeviceStore.store.addListener { category, _ ->
      if (category == "glasses") storeLoopers.add(Looper.myLooper())
    }
    diagnostics = NimoDiagnostics(context, Handler(Looper.getMainLooper()), send = { _, completed ->
      writes += 1
      writeCompleted = completed
      true
    })
    diagnostics.connected(512)
    // Install the real debug collaborator without requiring a Bluetooth radio handshake.
    Nimo::class.java.getDeclaredField("diagnostics").apply { isAccessible = true }
      .set(nimo, diagnostics)
    val root = File(context.filesDir, "nimo-framebuffer")
    val previous = root.listFiles()?.map { it.name }?.toSet() ?: emptySet()
    // Receiver permission enforcement is a device test; this starts its real capture path.
    NimoDiagnostics::class.java.getDeclaredMethod("start", String::class.java)
      .apply { isAccessible = true }.invoke(diagnostics, "capture")
    captureDirectory = root.listFiles()!!.single { it.name !in previous }
    assertEquals(1, writes)
  }

  @After fun dispose() {
    nimo.cleanup()
    Shadows.shadowOf(Looper.getMainLooper()).idle()
    encoderThread.join(1_000)
    listener?.let { DeviceStore.store.removeListener(it) }
    manager.cleanup()
    DeviceManager::class.java.getDeclaredField("_instance").apply { isAccessible = true }
      .set(null, previousManager)
  }

  @Test fun offMainDisconnectCompletesOnMainAndInterruptsActiveCapture() {
    runOffMain { nimo.disconnect() }
    assertDisconnectedOnMain()
    assertRememberedDevice()
  }

  @Test fun offMainForgetClearsRememberedDeviceAfterMainThreadTeardown() {
    runOffMain { nimo.forget() }
    assertDisconnectedOnMain()
    val prefs = context.getSharedPreferences("NimoPrefs", Context.MODE_PRIVATE)
    assertFalse(prefs.contains("nimo_lastDeviceAddress"))
    assertFalse(prefs.contains("nimo_lastDeviceName"))
    assertTrue(context.preferenceLoopers.all { it === Looper.getMainLooper() })
  }

  @Test fun offMainCleanupClosesDiagnosticsAfterMainThreadTeardown() {
    runOffMain { nimo.cleanup() }
    assertDisconnectedOnMain()
    assertRememberedDevice()
    encoderThread.join(1_000)
    assertFalse("Cleanup left its encoder thread alive", encoderThread.isAlive)
    // A closed diagnostic cannot register another receiver or start a new capture.
    diagnostics.connected(512)
    NimoDiagnostics::class.java.getDeclaredMethod("start", String::class.java)
      .apply { isAccessible = true }.invoke(diagnostics, "capture")
    assertEquals(1, writes)
  }

  private fun runOffMain(operation: () -> Unit) {
    val failure = AtomicReference<Throwable?>()
    val caller = Thread({
      try {
        operation()
        // The manager may replace this instance immediately after return. An asynchronous
        // post is insufficient: the old connection must already be completely torn down.
        assertEquals(false, DeviceStore.get("glasses", "connected"))
        assertEquals(false, DeviceStore.get("glasses", "fullyBooted"))
        assertTrue(File(captureDirectory, "session.json").exists())
      } catch (error: Throwable) { failure.set(error) }
    }, "Expo-AsyncFunctionQueue-test")
    caller.start()
    // The Main looper is paused, so no teardown may have run on the Expo worker.
    assertEquals(true, DeviceStore.get("glasses", "connected"))
    assertEquals(true, DeviceStore.get("glasses", "fullyBooted"))
    assertRememberedDevice()
    assertTrue(context.unregisterLoopers.isEmpty())
    assertTrue(storeLoopers.isEmpty())
    assertTrue("Encoder stopped before Main processed teardown", encoderThread.isAlive)
    assertFalse(File(captureDirectory, "session.json").exists())
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
    while (caller.isAlive && System.nanoTime() < deadline) {
      Shadows.shadowOf(Looper.getMainLooper()).idle()
      caller.join(10)
    }
    if (caller.isAlive) {
      caller.interrupt()
      caller.join(1_000)
      fail("Lifecycle did not return after Main processed teardown")
    }
    failure.get()?.let { throw AssertionError("Off-main lifecycle entrypoint failed", it) }
  }

  private fun assertDisconnectedOnMain() {
    assertEquals(false, DeviceStore.get("glasses", "connected"))
    assertEquals(false, DeviceStore.get("glasses", "fullyBooted"))
    assertEquals(ConnTypes.DISCONNECTED, DeviceStore.get("glasses", "connectionState"))
    assertEquals(listOf(Looper.getMainLooper()), context.unregisterLoopers)
    assertTrue(storeLoopers.isNotEmpty())
    assertTrue(storeLoopers.all { it === Looper.getMainLooper() })
    val receiptFile = File(captureDirectory, "session.json")
    val beforeLateCallback = receiptFile.readText()
    val receipt = JSONObject(beforeLateCallback)
    assertFalse(receipt.getBoolean("ok"))
    assertTrue(receipt.getString("error").contains("disconnected"))
    writeCompleted()
    Shadows.shadowOf(Looper.getMainLooper()).idle()
    assertEquals(beforeLateCallback, receiptFile.readText())
    assertEquals(1, writes)
  }

  private fun assertRememberedDevice() {
    val prefs = context.getSharedPreferences("NimoPrefs", Context.MODE_PRIVATE)
    assertEquals("00:11:22:33:44:55", prefs.getString("nimo_lastDeviceAddress", null))
    assertEquals("Nimo-test", prefs.getString("nimo_lastDeviceName", null))
  }
}
