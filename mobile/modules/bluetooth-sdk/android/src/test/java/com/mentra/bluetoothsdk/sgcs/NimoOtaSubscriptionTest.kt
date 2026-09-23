package com.mentra.bluetoothsdk.sgcs

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import com.mentra.bluetoothsdk.Bridge
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.annotation.LooperMode
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowBluetoothGatt

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], shadows = [NimoOtaSubscriptionTest.RecordingGatt::class])
@LooperMode(LooperMode.Mode.PAUSED)
class NimoOtaSubscriptionTest {
  @Implements(BluetoothGatt::class)
  class RecordingGatt : ShadowBluetoothGatt() {
    var descriptor: BluetoothGattDescriptor? = null
    @Implementation protected fun writeDescriptor(value: BluetoothGattDescriptor): Boolean {
      descriptor = value
      return true
    }
  }

  private fun field(nimo: Nimo, name: String, value: Any?) {
    Nimo::class.java.getDeclaredField(name).apply { isAccessible = true }.set(nimo, value)
  }
  private fun field(nimo: Nimo, name: String): Any? =
    Nimo::class.java.getDeclaredField(name).apply { isAccessible = true }.get(nimo)

  @Test fun transportAbortRequiresFreshOtaSubscriptionBeforeRecoveryCanReceiveReplies() {
    Bridge.initialize(ApplicationProvider.getApplicationContext())
    val nimo = Nimo()
    try {
      val device = BluetoothAdapter.getDefaultAdapter().getRemoteDevice("00:11:22:33:44:55")
      val old = ShadowBluetoothGatt.newInstance(device)
      val oldRx = BluetoothGattCharacteristic(NimoBLE.CHAR_OTA_RX, BluetoothGattCharacteristic.PROPERTY_NOTIFY, 0)
      field(nimo, "gatt", old)
      field(nimo, "otaRxChar", oldRx)
      field(nimo, "otaTxChar", oldRx)
      field(nimo, "otaNotificationsEnabled", true)
      field(nimo, "isDisconnecting", true)
      Nimo::class.java.getDeclaredMethod("abortTransport", String::class.java).apply { isAccessible = true }.invoke(nimo, "write timeout")
      assertNull(field(nimo, "otaRxChar")); assertNull(field(nimo, "otaTxChar"))
      assertEquals(false, field(nimo, "otaNotificationsEnabled"))

      val next = ShadowBluetoothGatt.newInstance(device)
      val shadow = Shadow.extract<RecordingGatt>(next)
      val rx = BluetoothGattCharacteristic(NimoBLE.CHAR_OTA_RX, BluetoothGattCharacteristic.PROPERTY_NOTIFY, 0)
      val descriptor = BluetoothGattDescriptor(NimoBLE.CLIENT_CHARACTERISTIC_CONFIG, BluetoothGattDescriptor.PERMISSION_WRITE)
      rx.addDescriptor(descriptor)
      shadow.allowCharacteristicNotification(rx)
      field(nimo, "gatt", next); field(nimo, "otaRxChar", rx)
      @Suppress("UNCHECKED_CAST")
      val writes = field(nimo, "writes") as NimoGattQueue<BluetoothGattCharacteristic>
      writes.connected(next)
      field(nimo, "otaTrafficPaused", true); field(nimo, "otaPrepareGeneration", 2)
      var prepared = false
      field(nimo, "otaPrepareCompletion", { error: Throwable? -> assertNull(error); prepared = true })
      Nimo::class.java.getDeclaredMethod("subscribeOtaChannel", BluetoothGatt::class.java, Int::class.javaPrimitiveType)
        .apply { isAccessible = true }.invoke(nimo, next, 2)
      assertSame(descriptor, shadow.descriptor)
      assertFalse(prepared)
      assertEquals(false, field(nimo, "otaNotificationsEnabled"))
      val callback = field(nimo, "gattCallback") as BluetoothGattCallback
      callback.onDescriptorWrite(old, descriptor, BluetoothGatt.GATT_SUCCESS)
      shadowOf(Looper.getMainLooper()).idle()
      assertFalse(prepared)
      callback.onDescriptorWrite(next, descriptor, BluetoothGatt.GATT_SUCCESS)
      shadowOf(Looper.getMainLooper()).idle()
      assertTrue(prepared)
      assertEquals(true, field(nimo, "otaNotificationsEnabled"))
    } finally { nimo.cleanup() }
  }
}
