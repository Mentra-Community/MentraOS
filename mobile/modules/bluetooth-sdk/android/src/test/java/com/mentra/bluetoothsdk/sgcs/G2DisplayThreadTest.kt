package com.mentra.bluetoothsdk.sgcs

import android.os.Looper
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertTrue
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadow.api.Shadow
import com.mentra.bluetoothsdk.Bridge
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], shadows = [RecordingGatt::class])
@LooperMode(LooperMode.Mode.PAUSED)
class G2DisplayThreadTest {
    @Test fun `worker clear cannot remove containers under the main-thread reconcile loop`() {
        Bridge.initialize(RuntimeEnvironment.getApplication())
        val g2 = G2()
        val add = G2::class.java.declaredMethods.single { it.name == "addTextContainer" }
        add.isAccessible = true
        add.invoke(g2, 0, 0, 576, 288, "captions", 0, 0, 0, 0)
        add.invoke(g2, 10, 10, 100, 40, "HUD", 0, 0, 0, 0)
        val field = G2::class.java.getDeclaredField("textContainers").apply { isAccessible = true }
        val containers = field.get(g2) as List<*>
        // This is the heartbeat's captured index range at the crash site.
        val indices = containers.indices
        val worker = Thread { g2.clearDisplay() }
        worker.start()
        worker.join()
        assertEquals(2, containers.size)
        indices.forEach { containers[it] } // crashed here when clear ran on the worker
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(1, containers.size) // only the positioned HUD husk is purged
    }

    @Test fun `closing positioned captions clears the live page without waiting for new speech`() {
        Bridge.initialize(RuntimeEnvironment.getApplication())
        val g2 = G2()
        val add = G2::class.java.declaredMethods.single { it.name == "addTextContainer" }
        add.isAccessible = true
        add.invoke(g2, 10, 10, 500, 100, "old captions", 0, 0, 0, 0)
        val page = G2::class.java.getDeclaredField("pageCreated").apply { isAccessible = true }
        page.setBoolean(g2, true)

        g2.clearDisplay()
        shadowOf(Looper.getMainLooper()).idle()

        val field = G2::class.java.getDeclaredField("textContainers").apply { isAccessible = true }
        assertEquals(0, (field.get(g2) as List<*>).size)
        // No shutdown or deferred recreation: the replacement page is already live,
        // even if the user remains silent and no new caption frame ever arrives.
        assertEquals(true, page.getBoolean(g2))
        g2.clearDisplay()
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(true, page.getBoolean(g2))
    }


    @Test fun `clear transmits an erase before dropping the old caption container and retries busy writes`() {
        Bridge.initialize(RuntimeEnvironment.getApplication())
        val g2 = G2()
        val gatt = Shadow.newInstanceOf(BluetoothGatt::class.java)
        val recorder = Shadow.extract<RecordingGatt>(gatt)
        recorder.rejectWrites = 1
        G2::class.java.getDeclaredField("rightGatt").apply { isAccessible = true }.set(g2, gatt)
        G2::class.java.getDeclaredField("rightWriteChar").apply { isAccessible = true }.set(
            g2, BluetoothGattCharacteristic(UUID.randomUUID(), 4, 16)
        )
        val add = G2::class.java.declaredMethods.single { it.name == "addTextContainer" }
        add.isAccessible = true
        add.invoke(g2, 10, 10, 500, 100, "old captions", 0, 0, 0, 0)
        G2::class.java.getDeclaredField("pageCreated").apply { isAccessible = true }.setBoolean(g2, true)

        g2.clearDisplay()
        shadowOf(Looper.getMainLooper()).idle()
        val executor = G2::class.java.getDeclaredField("bleWriteExecutor").apply { isAccessible = true }
            .get(g2) as ExecutorService
        executor.submit {}.get(5, TimeUnit.SECONDS)

        // Transport header is eight bytes; protobuf field 1 is the EvenHub command.
        val commands = recorder.accepted.map { it[9].toInt() }
        assertEquals(5, commands.first()) // UPDATE_TEXT_DATA, before REBUILD_PAGE (7)
        assertTrue(commands.indexOf(7) > 0)
        assertTrue(String(recorder.accepted.first(), Charsets.UTF_8).contains(" ".repeat(12)))
        assertTrue(recorder.attempted[0].contentEquals(recorder.attempted[1]))
        assertEquals(recorder.accepted.size + 1, recorder.attempted.size)
    }

}


@Implements(BluetoothGatt::class)
class RecordingGatt {
    var rejectWrites = 0
    val attempted = mutableListOf<ByteArray>()
    val accepted = mutableListOf<ByteArray>()

    @Implementation
    fun writeCharacteristic(characteristic: BluetoothGattCharacteristic): Boolean {
        val packet = characteristic.value.copyOf()
        attempted.add(packet)
        if (rejectWrites > 0) {
            rejectWrites--
            return false
        }
        accepted.add(packet)
        return true
    }
}
