package com.mentra.asg_client.service.core.handlers.subscribers;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.mentra.asg_client.io.bes.BesOtaManager;
import com.mentra.asg_client.io.peripheral.events.BesOtaAuthEvent;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** Verifies {@link BesOtaAuthEventSubscriber} routes the OTA authorization result correctly. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class BesOtaAuthEventSubscriberTest {

    private AsgClientServiceManager serviceManager;
    private BesOtaManager besOtaManager;
    private BesOtaAuthEventSubscriber subscriber;

    @Before
    public void setUp() {
        serviceManager = mock(AsgClientServiceManager.class);
        besOtaManager = mock(BesOtaManager.class);
        when(serviceManager.getBesOtaManager()).thenReturn(besOtaManager);
        subscriber = new BesOtaAuthEventSubscriber(serviceManager);
    }

    @Test
    public void authorized_grantsAuthorization() {
        subscriber.onMcuEvent(new BesOtaAuthEvent(true));

        verify(besOtaManager).onAuthorizationGranted();
        verify(besOtaManager, never()).onAuthorizationDenied();
    }

    @Test
    public void denied_deniesAuthorization() {
        subscriber.onMcuEvent(new BesOtaAuthEvent(false));

        verify(besOtaManager).onAuthorizationDenied();
        verify(besOtaManager, never()).onAuthorizationGranted();
    }

    @Test
    public void managerUnavailable_doesNotThrow() {
        when(serviceManager.getBesOtaManager()).thenReturn(null);

        subscriber.onMcuEvent(new BesOtaAuthEvent(true));
        // No exception expected; nothing to verify on a null manager.
    }
}
