package com.mentra.asg_client.io.network.managers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

import android.content.Context;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.io.network.interfaces.WifiForgetOutcome;
import com.mentra.asg_client.service.system.interfaces.ISystemController;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class K900NetworkManagerForgetDispatchTest {
    @Test
    public void reportsLocalDispatchWithoutClaimingVendorCompletion() {
        ISystemController systemController = mock(ISystemController.class);
        Context context = ApplicationProvider.getApplicationContext();
        K900NetworkManager manager = new K900NetworkManager(context, systemController);

        assertThat(manager.forgetWifiNetwork(" Field AP ")).isEqualTo(WifiForgetOutcome.DISPATCHED);

        verify(systemController).disconnectFromWifi(" Field AP ");
    }

    @Test
    public void reportsDispatchFailureWhenControllerThrows() {
        ISystemController systemController = mock(ISystemController.class);
        doThrow(new IllegalStateException("dispatch failed"))
                .when(systemController)
                .disconnectFromWifi("Field AP");
        Context context = ApplicationProvider.getApplicationContext();
        K900NetworkManager manager = new K900NetworkManager(context, systemController);

        assertThat(manager.forgetWifiNetwork("Field AP")).isEqualTo(WifiForgetOutcome.FAILED);
    }

    @Test
    public void rejectsSavedListWhenVendorHasNoResponsePath() {
        Context context = ApplicationProvider.getApplicationContext();
        K900NetworkManager manager = new K900NetworkManager(context, mock(ISystemController.class));

        assertThatThrownBy(manager::getConfiguredWifiNetworks)
                .isInstanceOf(UnsupportedOperationException.class)
                .hasMessageContaining("no vendor response path");
        assertThat(manager.getSavedWifiNetworksVersion()).isZero();
    }
}
