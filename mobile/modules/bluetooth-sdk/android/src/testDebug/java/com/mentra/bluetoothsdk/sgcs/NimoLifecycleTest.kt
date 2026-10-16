package com.mentra.bluetoothsdk.sgcs

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothGattCharacteristic
import org.robolectric.shadows.ShadowBluetoothGatt
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
    // Each Robolectric case has a new app/files directory; simulate its fresh process
    // rather than retaining the preceding test's registered receiver and output root.
    val collaborator = NimoResourceDiagnostics::class.java
    collaborator.getDeclaredField("capture").apply { isAccessible = true }.set(NimoResourceDiagnostics, null)
    collaborator.getDeclaredField("registered").apply { isAccessible = true }.setBoolean(NimoResourceDiagnostics, false)
    collaborator.getDeclaredField("application").apply { isAccessible = true }.set(NimoResourceDiagnostics, null)
    for (name in listOf("sessions", "requests")) {
      val value = collaborator.getDeclaredField(name).apply { isAccessible = true }.get(NimoResourceDiagnostics)
      if (value is MutableMap<*, *>) value.clear()
      if (value is MutableSet<*>) value.clear()
    }
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

  @Test fun resetForUnpairOfflineDoesNotSendFactoryCommand() {
    val results = mutableListOf<Boolean>()
    nimo.resetForUnpair { results.add(it) }
    assertEquals(listOf(false), results)
  }

  @Test fun explicitResetWaitsForMatchingAckAndCompletesOnlyOnce() {
    val frames = readyForReset()
    val results = mutableListOf<Boolean>()
    nimo.resetForUnpair { results.add(it) }
    Shadows.shadowOf(Looper.getMainLooper()).idle()
    assertTrue(results.isEmpty())
    assertArrayEquals(byteArrayOf(8, 3, 0, 0), frames.single().drop(8).toByteArray())
    assertEquals(2, frames.single()[1].toInt())
    respond(3, 1, 0)
    assertTrue(results.isEmpty())
    respond(8, 3, 0)
    respond(8, 3, 0)
    assertEquals(listOf(true), results)
    Shadows.shadowOf(Looper.getMainLooper()).idleFor(6, TimeUnit.SECONDS)
    assertEquals(listOf(true), results)
  }

  @Test fun resetTimeoutCompletesRatherThanLeavingUnpairWaitingForever() {
    readyForReset()
    val results = mutableListOf<Boolean>()
    nimo.resetForUnpair { results.add(it) }
    Shadows.shadowOf(Looper.getMainLooper()).idleFor(6, TimeUnit.SECONDS)
    assertEquals(listOf(false), results)
    respond(8, 3, 0)
    assertEquals(listOf(false), results)
  }

  @Test fun passiveForgetNeverSendsFactoryReset() {
    val frames = readyForReset()
    nimo.forget()
    assertTrue(frames.isEmpty())
  }

  @Test fun unbondTargetsOnlyTheSelectedNimo() {
    val adapter = BluetoothAdapter.getDefaultAdapter()
    val selected = adapter.getRemoteDevice("00:11:22:33:44:55")
    val other = adapter.getRemoteDevice("00:11:22:33:44:66")
    Shadows.shadowOf(selected).setCreatedBond(true)
    Shadows.shadowOf(other).setCreatedBond(true)
    Nimo.removeBluetoothBond(selected.address)
    // Robolectric tracks removeBond through this flag, independently of bondState.
    assertFalse(selected.createBond())
    assertTrue(other.createBond())
  }

  @Test fun resourceStatusIsPassiveAndReleaseRefusesCurrentG2Replacement() {
    readyForReset()
    setField("resourceSessionGeneration", 1L)
    setField("resourcePairAddress", "00:11:22:33:44:55")
    manager.sgc = nimo
    NimoResourceDiagnostics.start(context)
    NimoResourceDiagnostics.track(nimo)
    val status = resourceCommand("status")
    assertEquals(nimo.resourceInstanceId, status.getJSONObject("session").getString("instanceId"))
    assertTrue(status.getJSONObject("session").getBoolean("managedSessionPresent"))
    assertEquals(1, writes) // No diagnostic queries or scanner operations.
    manager.sgc = Simulated().apply { type = com.mentra.bluetoothsdk.utils.DeviceTypes.G2 }
    val released = resourceCommand("release")
    assertEquals("release-refused-replaced-or-unowned-target", released.getString("error"))
    assertTrue(nimo.resourceSnapshot().getBoolean("managedSessionPresent"))
    assertEquals(com.mentra.bluetoothsdk.utils.DeviceTypes.G2, manager.sgc?.type)
    assertEquals(true, DeviceStore.get("glasses", "connected"))
  }

  @Test fun resourceReleaseWaitsForOriginalMicStopMarkerAndPreservesBond() {
    readyForReset()
    setField("resourceSessionGeneration", 1L)
    setField("resourcePairAddress", "00:11:22:33:44:55")
    val mic = BluetoothGattCharacteristic(NimoBLE.CHAR_MIC, 8, 16)
    setField("micChar", mic)
    var result: JSONObject? = null
    nimo.releaseResource(1L, { true }) { result = it }
    Shadows.shadowOf(Looper.getMainLooper()).idleFor(50, TimeUnit.MILLISECONDS)
    assertNull("Write completion alone must not stand in for mic stop feedback", result)
    val gatt = field("gatt") as android.bluetooth.BluetoothGatt
    mic.value = byteArrayOf(0x52, 0, 0, 0)
    @Suppress("DEPRECATION")
    (field("gattCallback") as android.bluetooth.BluetoothGattCallback).onCharacteristicChanged(gatt, mic)
    Shadows.shadowOf(Looper.getMainLooper()).idleFor(200, TimeUnit.MILLISECONDS)
    val release = requireNotNull(result).getJSONObject("release")
    assertFalse(release.isNull("micStopWrittenAtEpochMs"))
    assertFalse(release.isNull("micStopMarkerAtEpochMs"))
    assertEquals("unknown", release.getString("micSilence"))
    assertEquals("unknown", release.getString("classicAclState"))
    assertTrue(release.getBoolean("gattCloseCalled"))
    assertTrue(requireNotNull(result).getBoolean("localEffectsSettled"))
    assertRememberedDevice()
  }

  @Test fun reconnectCannotReplaceOriginalGenerationDuringDelayedReleaseReceipt() {
    readyForReset()
    setField("resourceSessionGeneration", 1L)
    val originalGatt = field("gatt") as android.bluetooth.BluetoothGatt
    var result: JSONObject? = null
    nimo.releaseResource(1L, { true }) {
      result = it
      // Even reentrant connection requests inside receipt delivery remain fenced.
      nimo.connectById("replacement-at-completion")
      assertEquals(ConnTypes.DISCONNECTED, DeviceStore.get("glasses", "connectionState"))
    }
    Shadows.shadowOf(Looper.getMainLooper()).idle()
    assertNull(result)
    assertTrue(nimo.resourceSnapshot().getJSONObject("release").getBoolean("gattCloseCalled"))
    nimo.connectById("replacement-during-observation-window")
    assertEquals(ConnTypes.DISCONNECTED, DeviceStore.get("glasses", "connectionState"))
    assertNull(field("gatt"))
    // Late feedback from this exact closed bearer is still retained for its receipt.
    (field("gattCallback") as android.bluetooth.BluetoothGattCallback).onConnectionStateChange(
      originalGatt, android.bluetooth.BluetoothGatt.GATT_SUCCESS, android.bluetooth.BluetoothProfile.STATE_DISCONNECTED)
    Shadows.shadowOf(Looper.getMainLooper()).idleFor(150, TimeUnit.MILLISECONDS)
    val receipt = requireNotNull(result)
    assertEquals(1L, receipt.getLong("sessionGeneration"))
    assertFalse(receipt.getBoolean("managedSessionPresent"))
    assertTrue(receipt.getJSONObject("release").getBoolean("gattDisconnectCallbackObserved"))
    assertEquals(0, receipt.getJSONObject("release").getInt("gattDisconnectCallbackStatus"))
    // The completed receipt is a detached value, not a live view of later session fields.
    setField("resourceSessionGeneration", 2L)
    assertEquals(1L, receipt.getLong("sessionGeneration"))
  }

  @Test fun resourceMissingMicFeedbackLeavesStickyUnknownAfterTimeout() {
    readyForReset()
    setField("resourceSessionGeneration", 1L)
    setField("micChar", BluetoothGattCharacteristic(NimoBLE.CHAR_MIC, 8, 16))
    var result: JSONObject? = null
    nimo.releaseResource(1L, { true }) { result = it }
    Shadows.shadowOf(Looper.getMainLooper()).idleFor(16, TimeUnit.SECONDS)
    assertEquals("drain-timeout-native-effects-unknown", requireNotNull(result).getJSONObject("release").getString("result"))
    assertFalse(nimo.resourceSnapshot().getBoolean("localEffectsSettled"))
    assertTrue(nimo.resourceSnapshot().getJSONObject("release").isNull("micStopMarkerAtEpochMs"))
  }

  @Test fun readinessExportsOnlyFreshSameSessionStatusZeroAckAfterWriteStarted() {
    readyForReset()
    setField("resourceSessionGeneration", 3L)
    val state = Nimo::class.java.getDeclaredField("handshakeState")
    setField("handshakeState", state.type.enumConstants.single { it.toString() == "AWAITING_TWS" })
    Nimo::class.java.getDeclaredMethod("onTwsState", Boolean::class.javaPrimitiveType).apply { isAccessible = true }.invoke(nimo, true)
    Shadows.shadowOf(Looper.getMainLooper()).idleFor(10, TimeUnit.MILLISECONDS)
    respond(NimoProtocol.CMD_SET_PARAMETER, NimoProtocol.SET_TIME, 1)
    assertTrue(nimo.resourceSnapshot().getJSONObject("timeAck").isNull("atEpochMs"))
    Shadows.shadowOf(Looper.getMainLooper()).idleFor(600, TimeUnit.MILLISECONDS)
    respond(NimoProtocol.CMD_SET_PARAMETER, NimoProtocol.SET_TIME, 0)
    val snapshot = nimo.resourceSnapshot()
    assertEquals(3L, snapshot.getJSONObject("tws").getLong("sessionGeneration"))
    assertFalse(snapshot.getJSONObject("tws").isNull("atEpochMs"))
    assertEquals(0, snapshot.getJSONObject("timeAck").getInt("statusCode"))
    assertFalse(snapshot.getJSONObject("timeAck").isNull("writeStartedAtEpochMs"))
    assertEquals("READY", snapshot.getString("handshake"))
    val causalTws = snapshot.getJSONObject("tws").getLong("handshakeAtEpochMs")
    Shadows.shadowOf(Looper.getMainLooper()).idleFor(100, TimeUnit.MILLISECONDS)
    Nimo::class.java.getDeclaredMethod("onTwsState", Boolean::class.javaPrimitiveType).apply { isAccessible = true }.invoke(nimo, true)
    val heartbeat = nimo.resourceSnapshot()
    assertEquals(causalTws, heartbeat.getJSONObject("tws").getLong("handshakeAtEpochMs"))
    assertTrue(heartbeat.getJSONObject("tws").getLong("atEpochMs") > heartbeat.getJSONObject("timeAck").getLong("atEpochMs"))
    assertEquals("READY", heartbeat.getString("handshake"))
  }

  @Test fun callbacksFromPriorGattCannotCreateCurrentReadiness() {
    readyForReset()
    val old = field("gatt") as android.bluetooth.BluetoothGatt
    val other = BluetoothAdapter.getDefaultAdapter().getRemoteDevice("00:11:22:33:44:66")
    setField("gatt", ShadowBluetoothGatt.newInstance(other))
    val rx = BluetoothGattCharacteristic(NimoBLE.CHAR_RX, 16, 16)
    rx.value = byteArrayOf(0x52, 0, 0, 0)
    @Suppress("DEPRECATION")
    (field("gattCallback") as android.bluetooth.BluetoothGattCallback).onCharacteristicChanged(old, rx)
    Shadows.shadowOf(Looper.getMainLooper()).idle()
    assertTrue(nimo.resourceSnapshot().getJSONObject("tws").isNull("atEpochMs"))
    assertTrue(nimo.resourceSnapshot().getJSONObject("timeAck").isNull("atEpochMs"))
  }

  @Test fun firmwareFeedbackIsObservedWithinItsOwnSessionAndClearedOnReconnect() {
    readyForReset()
    setField("resourceSessionGeneration", 4L)
    assertTrue(nimo.resourceSnapshot().getJSONObject("firmware").isNull("version"))
    val response = Nimo::class.java.getDeclaredMethod("handleResponse", Int::class.javaPrimitiveType, Int::class.javaPrimitiveType, Int::class.javaPrimitiveType, ByteArray::class.java).apply { isAccessible = true }
    response.invoke(nimo, NimoProtocol.CMD_GET_PARAMETER, NimoProtocol.GET_VERSION, 1, byteArrayOf(1, 2, 3, 4))
    assertTrue(nimo.resourceSnapshot().getJSONObject("firmware").isNull("atEpochMs"))
    response.invoke(nimo, NimoProtocol.CMD_GET_PARAMETER, NimoProtocol.GET_VERSION_DETAIL, 0, "observed-test-version".toByteArray())
    val observed = nimo.resourceSnapshot().getJSONObject("firmware")
    assertEquals("observed-test-version", observed.getString("version"))
    assertEquals(4L, observed.getLong("sessionGeneration"))
    assertFalse(observed.isNull("atEpochMs"))
    // New transport generation clears the evidence independently of the product's UI version cache.
    setField("gatt", null); setField("isDisconnecting", false)
    val device = BluetoothAdapter.getDefaultAdapter().getRemoteDevice("00:11:22:33:44:55")
    Nimo::class.java.getDeclaredMethod("connectBredrTransport", android.bluetooth.BluetoothDevice::class.java).apply { isAccessible = true }.invoke(nimo, device)
    val fresh = nimo.resourceSnapshot().getJSONObject("firmware")
    assertEquals(5L, fresh.getLong("sessionGeneration"))
    assertTrue(fresh.isNull("version")); assertTrue(fresh.isNull("atEpochMs"))
  }

  @Test fun cancelledUnadmittedCaptureFencesLateConnectWithoutAdoptingManager() {
    manager.sgc = null
    NimoResourceDiagnostics.start(context)
    val nonce = java.util.UUID.randomUUID().toString()
    val armed = captureCommand("arm-capture", nonce, nonce)
    assertTrue(armed.getJSONObject("session").getJSONObject("capture").isNull("instanceId"))
    val cancelled = captureCommand("cancel-capture", nonce)
    assertTrue(cancelled.getJSONObject("session").getJSONObject("capture").getBoolean("cancelled"))
    manager.sgc = nimo
    assertFalse(NimoResourceDiagnostics.admit(nimo, "Nimo-test", true))
    assertFalse(NimoResourceDiagnostics.allowManagerConnect("NIMO", "Nimo-test"))
    assertTrue(NimoResourceDiagnostics.allowManagerConnect("G2", "other"))
    assertEquals(0L, nimo.resourceSnapshot().getLong("sessionGeneration"))
  }

  @Test fun capturePinsGenerationZeroBeforeEffectsAndRejectsWrongPeerAndReplacement() {
    manager.sgc = null
    NimoResourceDiagnostics.start(context)
    val nonce = java.util.UUID.randomUUID().toString()
    captureCommand("arm-capture", nonce, nonce)
    manager.sgc = nimo
    assertTrue(NimoResourceDiagnostics.admit(nimo, null, false))
    val admission = File(context.filesDir, "nimo-lifecycle/$nonce.admission.json").readText()
    assertEquals(nimo.resourceInstanceId, JSONObject(admission).getString("instanceId"))
    assertFalse(NimoResourceDiagnostics.allowPeer(nimo, "00:11:22:33:44:56", true))
    assertFalse(NimoResourceDiagnostics.allowPeer(nimo, "00:11:22:33:44:55", false)) // never create a new bond
    assertTrue(NimoResourceDiagnostics.admit(nimo, "Nimo-test", true))
    assertFalse(NimoResourceDiagnostics.admit(nimo, "Nimo-test", true))
    assertTrue(NimoResourceDiagnostics.beginTransport(nimo, "00:11:22:33:44:55", true))
    assertFalse(NimoResourceDiagnostics.beginTransport(nimo, "00:11:22:33:44:55", true))
    manager.sgc = Simulated().apply { type = com.mentra.bluetoothsdk.utils.DeviceTypes.G2 }
    assertFalse(NimoResourceDiagnostics.allowManagerConnect("NIMO", "Nimo-test"))
    assertEquals("capture-cancel-refused-replacement", captureCommand("cancel-capture", nonce).getString("error"))
    assertEquals(admission, File(context.filesDir, "nimo-lifecycle/$nonce.admission.json").readText())
    assertEquals(com.mentra.bluetoothsdk.utils.DeviceTypes.G2, manager.sgc?.type)
  }

  @Test fun captureAdmissionPersistenceFailurePreventsAnyConnectAndBecomesStickyFence() {
    manager.sgc = null
    NimoResourceDiagnostics.start(context)
    val nonce = java.util.UUID.randomUUID().toString()
    captureCommand("arm-capture", nonce, nonce)
    manager.sgc = nimo
    File(context.filesDir, "nimo-lifecycle/$nonce.admission.tmp").mkdir()
    assertFalse(NimoResourceDiagnostics.admit(nimo, "Nimo-test", true))
    assertFalse(NimoResourceDiagnostics.allowManagerConnect("NIMO", "Nimo-test"))
    assertEquals(0L, nimo.resourceSnapshot().getLong("sessionGeneration"))
  }

  @Test fun capturedGenerationZeroCancellationDrainsOriginalAndFencesQueuedAdmission() {
    manager.sgc = null
    NimoResourceDiagnostics.start(context)
    val nonce = java.util.UUID.randomUUID().toString()
    captureCommand("arm-capture", nonce, nonce)
    manager.sgc = nimo
    assertTrue(NimoResourceDiagnostics.admit(nimo, null, false))
    val cancelNonce = java.util.UUID.randomUUID().toString()
    NimoResourceDiagnostics.execute(android.content.Intent(NimoResourceDiagnostics.ACTION)
      .putExtra("nonce", cancelNonce).putExtra("mode", "cancel-capture").putExtra("expectedName", "Nimo-test")
      .putExtra("expectedAddress", "00:11:22:33:44:55").putExtra("captureNonce", nonce))
    Shadows.shadowOf(Looper.getMainLooper()).idleFor(200, TimeUnit.MILLISECONDS)
    val result = JSONObject(File(context.filesDir, "nimo-lifecycle/$cancelNonce.json").readText())
    val original = result.getJSONObject("session").getJSONObject("originalSession")
    assertEquals(0L, original.getLong("sessionGeneration"))
    assertFalse(original.getBoolean("managedSessionPresent"))
    assertEquals("local-drained-native-readback-required", original.getJSONObject("release").getString("result"))
    assertFalse(NimoResourceDiagnostics.admit(nimo, "Nimo-test", true))
    assertFalse(NimoResourceDiagnostics.allowPeer(nimo, "00:11:22:33:44:55", true))
  }

  @Test fun offMainManagerConnectIsQueuedWholeAndCancellationFencesItBeforeEffects() {
    manager.sgc = null
    NimoResourceDiagnostics.start(context)
    val nonce = java.util.UUID.randomUUID().toString()
    captureCommand("arm-capture", nonce, nonce)
    val thread = Thread { manager.connectDevice(com.mentra.bluetoothsdk.utils.DeviceTypes.NIMO, "Nimo-test") }
    thread.start(); awaitMainDispatch(thread)
    assertTrue(thread.isAlive)
    assertNull(manager.sgc) // no off-main manager creation or cleanup
    captureCommand("cancel-capture", nonce)
    Shadows.shadowOf(Looper.getMainLooper()).idle()
    thread.join(1000); assertFalse(thread.isAlive)
    assertNull(manager.sgc) // the already-queued real entry rechecks its immutable fence
  }

  @Test fun offMainOriginalNimoConnectAdmitsOnMainBeforeAnyPeerTransport() {
    manager.sgc = null
    NimoResourceDiagnostics.start(context)
    val nonce = java.util.UUID.randomUUID().toString()
    captureCommand("arm-capture", nonce, nonce)
    manager.sgc = nimo
    val thread = Thread { nimo.connectById("Nimo-test") }
    thread.start(); awaitMainDispatch(thread)
    val admission = File(context.filesDir, "nimo-lifecycle/$nonce.admission.json")
    assertFalse(admission.exists())
    Shadows.shadowOf(Looper.getMainLooper()).idle()
    thread.join(1000); assertFalse(thread.isAlive)
    assertEquals(nimo.resourceInstanceId, JSONObject(admission.readText()).getString("instanceId"))
    assertEquals(0L, nimo.resourceSnapshot().getLong("sessionGeneration"))
    assertFalse(nimo.resourceSnapshot().getBoolean("managedSessionPresent"))
  }

  @Test fun sdkConnectQueuedBeforeCancelCannotMutateDefaultOrDisconnectReplacementG2() {
    manager.sgc = null
    NimoResourceDiagnostics.start(context)
    val nonce = java.util.UUID.randomUUID().toString()
    captureCommand("arm-capture", nonce, nonce)
    // No SDK construction/hardware/analytics is needed: a fenced entry must return
    // before accessing collaborators. If the early guard regresses this test fails.
    val sdk = uninitializedSdk()
    DeviceStore.apply("bluetooth", "default_wearable", "unchanged-default")
    DeviceStore.apply("bluetooth", "pending_wearable", "unchanged-pending")
    val thread = Thread { sdk.connect(com.mentra.bluetoothsdk.Device(com.mentra.bluetoothsdk.DeviceModel.NIMO, "Nimo-test")) }
    thread.start(); awaitMainDispatch(thread)
    captureCommand("cancel-capture", nonce)
    val replacement = Simulated().apply { type = com.mentra.bluetoothsdk.utils.DeviceTypes.G2 }
    manager.sgc = replacement
    Shadows.shadowOf(Looper.getMainLooper()).idle()
    thread.join(1000); assertFalse(thread.isAlive)
    assertSame(replacement, manager.sgc)
    assertEquals("unchanged-default", DeviceStore.get("bluetooth", "default_wearable"))
    assertEquals("unchanged-pending", DeviceStore.get("bluetooth", "pending_wearable"))
    assertEquals(true, DeviceStore.get("glasses", "connected"))
  }

  @Test fun unarmedOrdinaryDebugEntryKeepsItsOriginalDirectExecution() {
    val caller = AtomicReference<Thread?>()
    val queued = AtomicReference<Boolean?>()
    val thread = Thread {
      queued.set(NimoResourceDiagnostics.dispatchCapturedEntry { fail("Unarmed debug must not queue") })
      caller.set(Thread.currentThread())
    }
    thread.start(); thread.join(1000)
    assertFalse(thread.isAlive)
    assertSame(thread, caller.get())
    assertEquals(false, queued.get())
  }

  @Test fun offMainSdkFailureIsDeliveredToCallerWithoutUncaughtMainException() {
    manager.sgc = null
    NimoResourceDiagnostics.start(context)
    val nonce = java.util.UUID.randomUUID().toString()
    captureCommand("arm-capture", nonce, nonce)
    val sdk = uninitializedSdk()
    DeviceStore.apply("bluetooth", "default_wearable", "")
    val failure = AtomicReference<Throwable?>()
    val thread = Thread { try { sdk.connectDefault() } catch (error: Throwable) { failure.set(error) } }
    thread.start(); awaitMainDispatch(thread)
    Shadows.shadowOf(Looper.getMainLooper()).idle() // FutureTask captures the error; main must not throw.
    thread.join(1000); assertFalse(thread.isAlive)
    assertTrue(failure.get() is com.mentra.bluetoothsdk.BluetoothSdkException)
    assertEquals("default_device_missing", (failure.get() as com.mentra.bluetoothsdk.BluetoothSdkException).code)
  }

  @Test fun onlyDiagnosticVariantRequiresArmForNimoAndExistingManagerCannotBeAdopted() {
    assertFalse(NimoResourceDiagnostics.allowUnarmedWearable("nimoDiagnostic", "NIMO"))
    assertTrue(NimoResourceDiagnostics.allowUnarmedWearable("nimoDiagnostic", "G2"))
    assertTrue(NimoResourceDiagnostics.allowUnarmedWearable("debug", "NIMO"))
    assertTrue(NimoResourceDiagnostics.allowUnarmedWearable("release", "NIMO"))
    manager.sgc = nimo
    NimoResourceDiagnostics.start(context)
    val nonce = java.util.UUID.randomUUID().toString()
    assertEquals("capture-arm-refused-existing-owner", captureCommand("arm-capture", nonce, nonce).getString("error"))
    assertEquals(0L, nimo.resourceSnapshot().getLong("sessionGeneration"))
  }

  private fun uninitializedSdk(): com.mentra.bluetoothsdk.MentraBluetoothSdk {
    // JVM fixture only. Reflection avoids Android bootclasspath references to JDK internals.
    val type = Class.forName("sun.misc.Unsafe")
    val allocator = type.getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
    return type.getMethod("allocateInstance", Class::class.java)
      .invoke(allocator, com.mentra.bluetoothsdk.MentraBluetoothSdk::class.java) as com.mentra.bluetoothsdk.MentraBluetoothSdk
  }

  private fun awaitMainDispatch(thread: Thread) {
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
    while (thread.isAlive && thread.state != Thread.State.WAITING && System.nanoTime() < deadline) Thread.yield()
    assertTrue("SDK caller must wait for its main-queue result", thread.isAlive)
    assertEquals(Thread.State.WAITING, thread.state)
  }

  private fun captureCommand(mode: String, captureNonce: String, requestNonce: String = java.util.UUID.randomUUID().toString()): JSONObject {
    NimoResourceDiagnostics.execute(android.content.Intent(NimoResourceDiagnostics.ACTION)
      .putExtra("nonce", requestNonce).putExtra("mode", mode).putExtra("expectedName", "Nimo-test")
      .putExtra("expectedAddress", "00:11:22:33:44:55").putExtra("captureNonce", captureNonce))
    return JSONObject(File(context.filesDir, "nimo-lifecycle/$requestNonce.json").readText())
  }

  private fun field(name: String): Any? = Nimo::class.java.getDeclaredField(name).apply { isAccessible = true }.get(nimo)

  private fun resourceCommand(mode: String): JSONObject {
    val nonce = java.util.UUID.randomUUID().toString()
    NimoResourceDiagnostics.execute(android.content.Intent(NimoResourceDiagnostics.ACTION)
      .putExtra("nonce", nonce).putExtra("mode", mode).putExtra("expectedAddress", "00:11:22:33:44:55")
      .putExtra("instanceId", nimo.resourceInstanceId).putExtra("sessionGeneration", 1L))
    val file = File(context.filesDir, "nimo-lifecycle/$nonce.json")
    return JSONObject(file.readText())
  }

  private fun readyForReset(): MutableList<ByteArray> {
    val frames = mutableListOf<ByteArray>()
    val device = BluetoothAdapter.getDefaultAdapter().getRemoteDevice("00:11:22:33:44:55")
    val gatt = ShadowBluetoothGatt.newInstance(device)
    setField("gatt", gatt)
    setField("txChar", BluetoothGattCharacteristic(NimoBLE.CHAR_TX, 8, 16))
    val state = Nimo::class.java.getDeclaredField("handshakeState")
    setField("handshakeState", state.type.enumConstants.single { it.toString() == "READY" })
    lateinit var queue: NimoGattQueue<BluetoothGattCharacteristic>
    queue = NimoGattQueue(
      NimoScheduler { delay, task ->
        val handler = Handler(Looper.getMainLooper())
        val pending = Runnable { task() }
        handler.postDelayed(pending, delay)
        val cancel: () -> Unit = { handler.removeCallbacks(pending) }
        cancel
      },
      { characteristic, bytes ->
        frames.add(bytes.copyOf())
        Handler(Looper.getMainLooper()).post { queue.written(gatt, characteristic, true) }
        true
      },
      { fail(it) },
      NimoBLE.INTER_FRAME_DELAY_MS,
    )
    queue.connected(gatt)
    setField("writes", queue)
    return frames
  }

  private fun setField(name: String, value: Any?) {
    Nimo::class.java.getDeclaredField(name).apply { isAccessible = true }.set(nimo, value)
  }

  private fun respond(cmd: Int, key: Int, status: Int) {
    Nimo::class.java.getDeclaredMethod("handleResponse", Int::class.javaPrimitiveType,
      Int::class.javaPrimitiveType, Int::class.javaPrimitiveType, ByteArray::class.java)
      .apply { isAccessible = true }.invoke(nimo, cmd, key, status, byteArrayOf())
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
