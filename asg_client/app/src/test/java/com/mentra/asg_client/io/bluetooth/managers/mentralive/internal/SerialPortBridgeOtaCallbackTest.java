package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

import android.app.Application;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.io.bluetooth.interfaces.SerialListener;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class SerialPortBridgeOtaCallbackTest {

    @Test
    public void otaApplied_notifiesNormalSerialOwner() {
        SerialPortBridge bridge =
                new SerialPortBridge(ApplicationProvider.getApplicationContext());
        SerialListener listener = mock(SerialListener.class);
        bridge.registerListener(listener);

        bridge.notifyBesOtaApplied();

        verify(listener).onBesOtaApplied();
    }
}
