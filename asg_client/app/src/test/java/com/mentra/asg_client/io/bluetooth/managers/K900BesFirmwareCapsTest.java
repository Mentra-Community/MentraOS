package com.mentra.asg_client.io.bluetooth.managers;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.mockito.Mockito.CALLS_REAL_METHODS;
import static org.mockito.Mockito.mock;

import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.BesUartTransportCoordinator;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.BesWireFormat;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.LinkStateMachine;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** A replaced BES build must not inherit the previous build's wire caps (uart_rx_pos). */
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
    }

    @Test public void sameBuildKeepsCapsAndAnotherBuildClearsThem() throws Exception {
        noteVersion("26.10.8.2");
        noteVersion("26.10.8.2");
        assertTrue(linkState.getNegotiatedCaps().uartRxPos);

        noteVersion("26.10.6.0");
        assertFalse(linkState.getNegotiatedCaps().uartRxPos);
    }

    @Test public void appliedOtaClearsCapsBeforeTheNewBuildReports() {
        manager.onBesOtaApplied();
        assertFalse(linkState.getNegotiatedCaps().uartRxPos);
    }

    private void noteVersion(String version) throws Exception {
        Method method = K900BluetoothManager.class.getDeclaredMethod(
                "noteBesFirmwareVersion", String.class);
        method.setAccessible(true);
        method.invoke(manager, version);
    }

    private void set(String name, Object value) throws Exception {
        Field field = K900BluetoothManager.class.getDeclaredField(name);
        field.setAccessible(true);
        field.set(manager, value);
    }
}
