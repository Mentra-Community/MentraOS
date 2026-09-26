package com.mentra.bluetoothsdk.sgcs.ar99.ota

import android.bluetooth.BluetoothGatt
import android.os.Looper
import java.time.Duration
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [33])
@LooperMode(LooperMode.Mode.PAUSED)
class Ar99OtaOwnershipTest {
  private class Transport(val manager: Ar99OtaManager) : OtaGattTransport {
    var notifications = true
    var mtus = 0
    val writes = mutableListOf<ByteArray>()
    override fun enableOtaNotification() = notifications
    override fun sendOtaData(data: ByteArray) { writes += data }
    override fun requestMtu(mtu: Int) { mtus++; manager.handleGattMtuChangedForOta(BluetoothGatt.GATT_SUCCESS) }
    override fun isBleConnected() = true
  }
  @Test fun preparationOwnsManagerAndCanPauseBeforeFirstCommand() {
    val manager = Ar99OtaManager(); val transport = Transport(manager); manager.setTransport(transport)
    assertTrue(manager.startOTA(byteArrayOf(1, 2, 3)))
    manager.handleOTAResponse(byteArrayOf(9, 6, 0x80.toByte(), 1, 0, 1)) // Late validation before this request.
    assertTrue(manager.isOTAInProgress()); assertFalse(manager.startOTA(byteArrayOf(9)))
    manager.onBleDisconnected(); assertTrue(manager.isPausedWaitingReconnect())
    manager.cancelOTA(); assertFalse(manager.isOTAInProgress())
    transport.notifications = false
    assertFalse(manager.startOTA(byteArrayOf(1))); assertFalse(manager.isOTAInProgress())
  }
  @Test fun oldNotificationTimerCannotNegotiateANewAttemptEarlyAndWireBytesStayUnchanged() {
    val manager = Ar99OtaManager(); val transport = Transport(manager); manager.setTransport(transport)
    manager.startOTA(byteArrayOf(9)); manager.onOtaNotifyEnabled()
    Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(500))
    manager.cancelOTA(); manager.startOTA(byteArrayOf(1, 2, 3)); manager.onOtaNotifyEnabled()
    Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(500))
    assertEquals(0, transport.mtus)
    Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(500))
    assertEquals(1, transport.mtus); assertTrue(transport.writes.isEmpty())
    Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(500))
    assertEquals("0901800b00090100010a040300000000", transport.writes.single().joinToString("") { "%02x".format(it.toInt() and 255) })
    manager.cancelOTA()
  }
}
