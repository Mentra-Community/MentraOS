package com.mentra.asg_client.io.ota.helpers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.*;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;

import com.mentra.asg_client.io.network.interfaces.INetworkManager;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaRegistry;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

@RunWith(RobolectricTestRunner.class)
public class OtaDowngradeNetworkCleanupTest {
    private OtaHelper helper;
    private INetworkManager network;

    @Before
    public void setUp() {
        Context context = ApplicationProvider.getApplicationContext();
        helper = new OtaHelper(context, mock(IBesOtaRegistry.class));
        network = mock(INetworkManager.class);
        helper.setNetworkManager(network);
    }

    @After
    public void tearDown() {
        helper.cleanup();
    }

    @Test
    public void handsOffOnlyAfterTheExistingOwnerVerifiesNativeStop() throws Exception {
        assertThat(helper.prepareNetworkForDowngrade()).isTrue();
        verify(network).stopHotspotAndAwaitDisabled();
        verifyNoMoreInteractions(network);
    }

    @Test
    public void nativeStopFailureRefusesHandoffInsteadOfKillingTheOwner() throws Exception {
        doThrow(new java.io.IOException("AP remained registered"))
                .when(network)
                .stopHotspotAndAwaitDisabled();
        assertThat(helper.prepareNetworkForDowngrade()).isFalse();
        verify(network).stopHotspotAndAwaitDisabled();
    }

    @Test
    public void missingServiceOwnerRefusesTheDestructiveHandoff() {
        helper.setNetworkManager(null);
        assertThat(helper.prepareNetworkForDowngrade()).isFalse();
        verifyNoInteractions(network);
    }
}
