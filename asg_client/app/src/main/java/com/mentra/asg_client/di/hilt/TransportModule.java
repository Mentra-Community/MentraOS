package com.mentra.asg_client.di.hilt;

import android.content.Context;
import com.mentra.asg_client.io.bluetooth.core.BluetoothManagerFactory;
import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.K900ProtocolStrategy;
import com.mentra.asg_client.io.network.core.NetworkManagerFactory;
import com.mentra.asg_client.io.network.interfaces.INetworkManager;
import com.mentra.asg_client.service.core.processors.CommandProtocolDetector;
import dagger.Module;
import dagger.Provides;
import dagger.hilt.InstallIn;
import dagger.hilt.android.qualifiers.ApplicationContext;
import dagger.hilt.components.SingletonComponent;
import dagger.multibindings.IntoSet;

/**
 * Vendor wiring for the companion transport layer. Binds device-specific implementations (selected
 * via the existing factories) to the core transport interfaces, and contributes vendor protocol
 * detection strategies to the core {@link CommandProtocolDetector}.
 *
 * <p>The transport and network providers are intentionally UNSCOPED: {@code
 * AsgClientServiceManager.cleanup()} shuts the transport down when the service is destroyed, so a
 * singleton binding would re-inject a dead instance on service restart. Unscoped providers match
 * the previous fresh-instance-per-service-creation factory behavior.
 */
@Module
@InstallIn(SingletonComponent.class)
public class TransportModule {

    /**
     * Mentra Live MCU wire-format detection. Registered into the core protocol detector at
     * runtime so core never imports vendor classes.
     */
    @Provides
    @IntoSet
    static CommandProtocolDetector.ProtocolDetectionStrategy provideK900ProtocolStrategy() {
        return new K900ProtocolStrategy();
    }

    /** Device-appropriate companion transport (K900 UART bridge or standard BLE). */
    @Provides
    static ICompanionTransport provideCompanionTransport(@ApplicationContext Context context) {
        return BluetoothManagerFactory.getBluetoothManager(context);
    }

    /** Device-appropriate network manager (K900, system-privileged, or fallback). */
    @Provides
    static INetworkManager provideNetworkManager(@ApplicationContext Context context) {
        return NetworkManagerFactory.getNetworkManager(context);
    }
}
