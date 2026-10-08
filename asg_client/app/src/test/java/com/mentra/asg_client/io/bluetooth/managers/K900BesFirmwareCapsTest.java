package com.mentra.asg_client.io.bluetooth.managers;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.mockito.Mockito.CALLS_REAL_METHODS;
import static org.mockito.Mockito.mock;

import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.BesUartTransportCoordinator;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.BesWireFormat;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.K900LengthCodec;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.LinkStateMachine;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** A replaced BES build must not inherit the previous build's negotiated wire caps or endianness. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class K900BesFirmwareCapsTest {
    private K900BluetoothManager manager;
    private LinkStateMachine linkState;

    @Before public void setUp() throws Exception {
        manager = mock(K900BluetoothManager.class, CALLS_REAL_METHODS);
        linkState = new LinkStateMachine();
        set("linkState", linkState);
        set("transportCoordinator", mock(BesUartTransportCoordinator.class));
        linkState.serialReady();
        linkState.srSyvrParsed(new LinkStateMachine.BesCaps(true, true, true, true,
                BesWireFormat.PROTOCOL_VERSION_V2, 253, true, true, true));
        set("uartToBesEndian", K900LengthCodec.Endian.LE);
    }

    @Test public void sameBuildKeepsCapsAndAnotherBuildClearsThem() throws Exception {
        noteVersion("26.10.8.2");
        noteVersion("26.10.8.2");
        assertTrue(linkState.getNegotiatedCaps().uartRxPos);
        assertEquals(K900LengthCodec.Endian.LE, get("uartToBesEndian"));

        noteVersion("26.10.6.0");
        assertFalse(linkState.getNegotiatedCaps().uartRxPos);
        assertEquals(K900LengthCodec.Endian.BE, get("uartToBesEndian"));
    }

    @Test public void appliedOtaClearsCapsBeforeTheNewBuildReports() throws Exception {
        manager.onBesOtaApplied();
        assertFalse(linkState.getNegotiatedCaps().uartRxPos);
        assertEquals(K900LengthCodec.Endian.BE, get("uartToBesEndian"));
    }

    private void noteVersion(String version) throws Exception {
        Method method = K900BluetoothManager.class.getDeclaredMethod(
                "noteBesFirmwareVersion", String.class);
        method.setAccessible(true);
        method.invoke(manager, version);
    }

    private Object get(String name) throws Exception {
        Field field = K900BluetoothManager.class.getDeclaredField(name);
        field.setAccessible(true);
        return field.get(manager);
    }

    private void set(String name, Object value) throws Exception {
        Field field = K900BluetoothManager.class.getDeclaredField(name);
        field.setAccessible(true);
        field.set(manager, value);
    }
}
