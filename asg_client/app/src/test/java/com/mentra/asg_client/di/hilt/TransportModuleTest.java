package com.mentra.asg_client.di.hilt;

import static org.assertj.core.api.Assertions.assertThat;

import android.content.Context;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.io.bluetooth.managers.StandardBluetoothManager;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.K900ProtocolStrategy;
import com.mentra.asg_client.io.network.interfaces.INetworkManager;
import com.mentra.asg_client.service.core.processors.CommandProtocolDetector;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowBuild;

/**
 * Verifies {@link TransportModule} vendor-wiring providers: device-appropriate transport/network
 * selection and the unscoped (fresh-instance-per-injection) lifecycle contract.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class TransportModuleTest {

    private static Context genericDeviceContext() {
        ShadowBuild.setModel("Pixel 7");
        ShadowBuild.setProduct("pixel_7");
        ShadowBuild.setManufacturer("Google");
        return ApplicationProvider.getApplicationContext();
    }

    @Test
    public void provideK900ProtocolStrategy_returnsMcuWireFormatStrategy() {
        CommandProtocolDetector.ProtocolDetectionStrategy strategy =
                TransportModule.provideK900ProtocolStrategy();

        assertThat(strategy).isInstanceOf(K900ProtocolStrategy.class);
        assertThat(strategy.getProtocolType())
                .isEqualTo(CommandProtocolDetector.ProtocolType.K900_PROTOCOL);
    }

    @Test
    public void provideCompanionTransport_genericDevice_returnsStandardManager() {
        Context context = genericDeviceContext();

        ICompanionTransport transport = TransportModule.provideCompanionTransport(context);

        assertThat(transport).isInstanceOf(StandardBluetoothManager.class);
    }

    @Test
    public void provideCompanionTransport_unscoped_returnsFreshInstancePerCall() {
        // Lifecycle contract: AsgClientServiceManager.cleanup() shuts the transport down on
        // service destroy. A cached/singleton transport would be dead after a service restart,
        // so every injection must build a fresh instance.
        Context context = genericDeviceContext();

        ICompanionTransport first = TransportModule.provideCompanionTransport(context);
        ICompanionTransport second = TransportModule.provideCompanionTransport(context);

        assertThat(first).isNotSameAs(second);
    }

    @Test
    public void provideNetworkManager_returnsManagerAndFreshInstancePerCall() {
        Context context = genericDeviceContext();

        INetworkManager first = TransportModule.provideNetworkManager(context);
        INetworkManager second = TransportModule.provideNetworkManager(context);

        assertThat(first).isNotNull();
        assertThat(second).isNotNull();
        assertThat(first).isNotSameAs(second);
    }
}
