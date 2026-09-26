package com.mentra.bluetoothsdk.sgcs

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattService
import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import com.mentra.bluetoothsdk.Bridge
import com.mentra.bluetoothsdk.DeviceManager
import com.mentra.bluetoothsdk.DeviceStore
import com.mentra.bluetoothsdk.utils.ConnTypes
import java.util.UUID
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import org.robolectric.shadows.ShadowBluetoothGatt

/** Exercise real receive dispatch, not just the already-tested canvas state machine. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
@LooperMode(LooperMode.Mode.PAUSED)
@Suppress("deprecation")
class NimoReadinessDriverTest {
  private lateinit var nimo: Nimo
  private lateinit var encoderThread: Thread
  private lateinit var manager: DeviceManager
  private var previousManager: DeviceManager? = null
  private lateinit var callback: BluetoothGattCallback
  private lateinit var currentGatt: BluetoothGatt
  private lateinit var rx: BluetoothGattCharacteristic
  private lateinit var canvas: NimoCanvasCoordinator
  private val frames = mutableListOf<ByteArray>()
  private val failures = mutableListOf<String>()
  private val rejections = mutableListOf<Int>()
  private val savedStore = mutableMapOf<String, Any>()

  @Before fun setup() {
    Bridge.initialize(ApplicationProvider.getApplicationContext<Context>())
    manager = DeviceManager(initializeHardware = false)
    DeviceManager::class.java.getDeclaredField("_instance").apply { isAccessible = true }.let {
      previousManager = it.get(null) as DeviceManager?
      it.set(null, manager)
    }
    for (key in listOf("connected", "fullyBooted", "connectionState", "headUp", "voiceActivityDetectionEnabled")) {
      DeviceStore.get("glasses", key)?.let { savedStore[key] = it }
    }
    // Suppress unrelated manager side effects when finishHandshake republishes these values.
    DeviceStore.set("glasses", "connected", true)
    DeviceStore.set("glasses", "fullyBooted", true)
    DeviceStore.set("glasses", "connectionState", ConnTypes.CONNECTED)
    val before = Thread.getAllStackTraces().keys
    nimo = Nimo()
    encoderThread = Thread.getAllStackTraces().keys.single {
      it.name == "NimoCanvasEncoder" && it !in before
    }
    callback = field("gattCallback").get(nimo) as BluetoothGattCallback
    currentGatt = newGatt()
    field("gatt").set(nimo, currentGatt)
    rx = characteristic(NimoBLE.SERVICE_UUID)
    val handler = Handler(Looper.getMainLooper())
    canvas = NimoCanvasCoordinator(NimoScheduler { delay, task ->
      val runnable = Runnable(task)
      handler.postDelayed(runnable, delay)
      ({ handler.removeCallbacks(runnable) })
    }, { 512 }, { chain, started, completed ->
      frames.addAll(chain.map { it.copyOf() })
      started()
      completed()
      true
    }, { failures.add(it) }, { rejections.add(it) })
    field("canvas").set(nimo, canvas)
  }

  @After fun dispose() {
    try {
      nimo.cleanup()
      idle()
      encoderThread.join(1_000)
      assertFalse("Encoder thread leaked", encoderThread.isAlive)
    } finally {
      manager.cleanup()
      savedStore.forEach { (key, value) -> DeviceStore.set("glasses", key, value) }
      DeviceManager::class.java.getDeclaredField("_instance").apply { isAccessible = true }
        .set(null, previousManager)
    }
  }

  @Test fun onlyCompleteSuccessfulHeartbeatReleasesNotReadyAndSendsLatestScene() {
    val latest = byteArrayOf(1, 0, 1)
    canvas.offer(byteArrayOf(0, 0, 1), "first")
    finishHandshake(peer = true)
    assertKeys(1)
    emit(packet(7, 1, byteArrayOf(7)))
    assertEquals(listOf(7), rejections)
    canvas.offer(latest, "latest")

    emit(packet(6, 3, byteArrayOf(0, 1))) // TWS alone cannot refresh peer readiness.
    emit(heartbeat(status = 7))
    emit(packet(6, 4, byteArrayOf(0, 3) + ByteArray(9))) // Missing slaveGatt.
    val corrupt = heartbeat().also { it[it.lastIndex] = 2 } // Invalid CRC.
    emit(corrupt)
    assertKeys(1)

    emit(heartbeat())
    assertKeys(1, 1)
    emit(heartbeat()) // No overlapping Launch while awaiting its ACK.
    assertKeys(1, 1)
    emit(packet(7, 1, byteArrayOf(0, 0xFD.toByte())))
    assertKeys(1, 1, 4)
    assertArrayEquals(NimoCanvasCodec.frames(4, latest, 512).single(), frames.last())
    assertTrue(failures.isEmpty())
  }

  @Test fun unknownPeerCannotLaunchFromHandshakeOrTwsOnlyReports() {
    canvas.offer(byteArrayOf(0, 0, 1), "initial")
    finishHandshake(peer = null)
    assertKeys()
    emit(packet(6, 3, byteArrayOf(0, 1)))
    assertNull(field("peerCompanionReady").get(nimo))
    assertKeys()
    emit(heartbeat(peer = 0))
    assertEquals(false, field("peerCompanionReady").get(nimo))
    assertKeys()
    emit(heartbeat())
    assertEquals(true, field("peerCompanionReady").get(nimo))
    assertKeys(1)
    assertTrue(failures.isEmpty())
  }

  @Test fun queuedOldGattAndWrongServiceCannotEstablishReadiness() {
    canvas.offer(byteArrayOf(0, 0, 1), "initial")
    finishHandshake(peer = null)
    val oldGatt = currentGatt
    queue(heartbeat(), oldGatt)
    currentGatt = newGatt()
    field("gatt").set(nimo, currentGatt)
    idle() // The generation check must occur when the queued callback executes.
    emit(heartbeat(), oldGatt)
    emit(heartbeat(), currentGatt, characteristic(UUID.fromString("00001234-0000-1000-8000-00805f9b34fb")))
    assertNull(field("peerCompanionReady").get(nimo))
    assertKeys()

    emit(heartbeat()) // Positive control through the actual current RX callback.
    assertKeys(1)
    oldGatt.close()
    assertTrue(failures.isEmpty())
  }

  private fun finishHandshake(peer: Boolean?) {
    field("twsConnected").set(nimo, true)
    field("peerCompanionReady").set(nimo, peer)
    Nimo::class.java.getDeclaredMethod("finishHandshake").apply { isAccessible = true }.invoke(nimo)
    idle()
  }

  private fun newGatt(): BluetoothGatt = ShadowBluetoothGatt.newInstance(
    BluetoothAdapter.getDefaultAdapter().getRemoteDevice("00:11:22:33:44:55"),
  )

  private fun characteristic(serviceId: UUID): BluetoothGattCharacteristic {
    val characteristic = BluetoothGattCharacteristic(NimoBLE.CHAR_RX,
      BluetoothGattCharacteristic.PROPERTY_NOTIFY, BluetoothGattCharacteristic.PERMISSION_READ)
    BluetoothGattService(serviceId, BluetoothGattService.SERVICE_TYPE_PRIMARY).addCharacteristic(characteristic)
    return characteristic
  }

  private fun heartbeat(status: Int = 0, peer: Int = 1) = packet(6, 4,
    byteArrayOf(status.toByte(), 3) + ByteArray(8) + byteArrayOf(1, peer.toByte()))

  private fun packet(command: Int, key: Int, payload: ByteArray) =
    NimoFrameCodec.encodeFrame(command, key, payload, needsAck = false)

  private fun queue(packet: ByteArray, gatt: BluetoothGatt = currentGatt,
                    characteristic: BluetoothGattCharacteristic = rx) {
    characteristic.value = packet.copyOf()
    callback.onCharacteristicChanged(gatt, characteristic)
  }

  private fun emit(packet: ByteArray, gatt: BluetoothGatt = currentGatt,
                   characteristic: BluetoothGattCharacteristic = rx) {
    queue(packet, gatt, characteristic)
    idle()
  }

  private fun idle() = Shadows.shadowOf(Looper.getMainLooper()).idle()
  private fun field(name: String) = Nimo::class.java.getDeclaredField(name).apply { isAccessible = true }
  private fun assertKeys(vararg expected: Int) =
    assertEquals(expected.toList(), frames.map { it[9].toInt() and 255 })
}
