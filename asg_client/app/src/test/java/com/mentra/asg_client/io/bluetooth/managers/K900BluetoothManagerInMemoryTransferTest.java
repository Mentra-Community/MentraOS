package com.mentra.asg_client.io.bluetooth.managers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.atLeastOnce;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.mockStatic;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import androidx.test.core.app.ApplicationProvider;
import com.lhs.serialport.api.SerialManager;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.SerialPortBridge;
import java.lang.reflect.Field;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.MockedStatic;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Covers the K900 in-memory (byte[]) file-transfer path added to {@link K900BluetoothManager}:
 * {@code sendFile(byte[], String)} -> {@code sendFileInternal(byte[], String)} ->
 * {@code startFileTransferSession}. The BES UART bridge is faked so the transfer logic runs without
 * the native {@code lhsserial} library or a physical /dev/ttyS1 port.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class K900BluetoothManagerInMemoryTransferTest {

    private K900BluetoothManager manager;
    private SerialPortBridge serial;

    @Before
    public void setUp() throws Exception {
        // The constructor opens the real UART; stub the native serial layer so it fails cleanly
        // (returns false) instead of throwing UnsatisfiedLinkError on the JVM.
        try (MockedStatic<SerialManager> serialManager = mockStatic(SerialManager.class)) {
            SerialManager stub = mock(SerialManager.class);
            when(stub.openSerial(anyString(), anyInt())).thenReturn(false);
            serialManager.when(SerialManager::getInstance).thenReturn(stub);
            manager = new K900BluetoothManager(ApplicationProvider.getApplicationContext());
        }

        // Swap in a fake UART bridge that accepts every write, and mark the link ready so the
        // in-memory transfer proceeds past the serial-open guard.
        serial = mock(SerialPortBridge.class);
        when(serial.sendFile(any())).thenReturn(true);
        setField(manager, "comManager", serial);
        setField(manager, "isSerialOpen", true);
    }

    @After
    public void tearDown() {
        if (manager != null) {
            manager.shutdown();
        }
    }

    @Test
    public void inMemorySendFile_startsSessionAndStreamsPacketsOverUart() throws Exception {
        byte[] payload = new byte[1024];
        for (int i = 0; i < payload.length; i++) {
            payload[i] = (byte) i;
        }

        boolean started = manager.sendFile(payload, "photo_from_memory.jpg");

        assertThat(started).isTrue();
        assertThat(manager.isFileTransferInProgress()).isTrue();
        verify(serial, atLeastOnce()).sendFile(any());
        verify(serial).setFastMode(true);
        // The K900 protocol caps the wire name at 16 chars; the in-memory path must truncate too.
        assertThat(activeTransferFileName(manager)).isEqualTo("photo_from_memor");
    }

    @Test
    public void inMemorySendFile_rejectsEmptyOrMissingArguments() {
        assertThat(manager.sendFile(null, "photo.jpg")).isFalse();
        assertThat(manager.sendFile(new byte[0], "photo.jpg")).isFalse();
        assertThat(manager.sendFile(new byte[] {1, 2, 3}, null)).isFalse();
        assertThat(manager.sendFile(new byte[] {1, 2, 3}, "")).isFalse();

        assertThat(manager.isFileTransferInProgress()).isFalse();
        verify(serial, never()).sendFile(any());
    }

    @Test
    public void inMemorySendFile_failsWhenSerialClosed() throws Exception {
        setField(manager, "isSerialOpen", false);

        boolean started = manager.sendFile(new byte[] {1, 2, 3}, "photo.jpg");

        assertThat(started).isFalse();
        assertThat(manager.isFileTransferInProgress()).isFalse();
        verify(serial, never()).sendFile(any());
    }

    private static String activeTransferFileName(K900BluetoothManager manager) throws Exception {
        Field sessionField = findField(manager.getClass(), "currentFileTransfer");
        sessionField.setAccessible(true);
        Object session = sessionField.get(manager);
        assertThat(session).isNotNull();
        Field nameField = findField(session.getClass(), "fileName");
        nameField.setAccessible(true);
        return (String) nameField.get(session);
    }

    private static void setField(Object target, String name, Object value) throws Exception {
        Field field = findField(target.getClass(), name);
        field.setAccessible(true);
        field.set(target, value);
    }

    private static Field findField(Class<?> type, String name) throws NoSuchFieldException {
        for (Class<?> current = type; current != null; current = current.getSuperclass()) {
            try {
                return current.getDeclaredField(name);
            } catch (NoSuchFieldException ignored) {
                // Keep walking up the hierarchy.
            }
        }
        throw new NoSuchFieldException(name);
    }
}
