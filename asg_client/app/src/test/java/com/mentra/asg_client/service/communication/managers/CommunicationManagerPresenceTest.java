package com.mentra.asg_client.service.communication.managers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.io.bluetooth.managers.K900BluetoothManager;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.LinkStateMachine;
import com.mentra.asg_client.io.network.interfaces.INetworkManager;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * OtaHelper.PhoneConnectionProvider presence semantics: the BES-reported phone BLE presence is
 * authoritative when known, and the historical transport-based answer is preserved verbatim when
 * presence is UNKNOWN — the OTA and wifi flows must keep working against old BES firmware that
 * never reports presence.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class CommunicationManagerPresenceTest {

    private K900BluetoothManager transport;
    private LinkStateMachine linkState;
    private CommunicationManager communicationManager;

    @Before
    public void setUp() {
        transport = mock(K900BluetoothManager.class);
        linkState = new LinkStateMachine();
        when(transport.getLinkStateMachine()).thenReturn(linkState);
        communicationManager =
                new CommunicationManager(transport, mock(INetworkManager.class));
    }

    @Test
    public void unknownPresence_fallsBackToTransportState() {
        // Old BES firmware: no presence signal ever arrives. Behavior must be exactly the
        // pre-presence transport check, in both directions.
        when(transport.isConnected()).thenReturn(true);
        assertThat(communicationManager.isPhoneConnected()).isTrue();

        when(transport.isConnected()).thenReturn(false);
        assertThat(communicationManager.isPhoneConnected()).isFalse();
    }

    @Test
    public void presentPresence_isAuthoritativeOverTransport() {
        linkState.serialReady();
        linkState.phonePresenceReported(true);
        when(transport.isConnected()).thenReturn(false);

        assertThat(communicationManager.isPhoneConnected()).isTrue();
    }

    @Test
    public void absentPresence_isAuthoritativeOverTransport() {
        linkState.serialReady();
        linkState.phonePresenceReported(false);
        when(transport.isConnected()).thenReturn(true);

        assertThat(communicationManager.isPhoneConnected()).isFalse();
    }

    @Test
    public void presenceInvalidation_restoresTheTransportFallback() {
        linkState.serialReady();
        linkState.phonePresenceReported(false);
        linkState.phonePresenceInvalidated();
        when(transport.isConnected()).thenReturn(true);

        assertThat(communicationManager.isPhoneConnected()).isTrue();
    }

    @Test
    public void nonK900Transport_usesTransportState() {
        ICompanionTransport plainTransport = mock(ICompanionTransport.class);
        when(plainTransport.isConnected()).thenReturn(true);
        CommunicationManager plain =
                new CommunicationManager(plainTransport, mock(INetworkManager.class));

        assertThat(plain.isPhoneConnected()).isTrue();
    }
}
