package com.mentra.asg_client.service.core.handlers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.when;

import android.app.Application;

import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.io.bluetooth.managers.K900BluetoothManager;
import com.mentra.asg_client.service.core.AsgClientService;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.InOrder;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** Version queries may request a guarded BES probe without resetting phone state. */
@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class VersionCommandHandlerTest {
    private final AsgClientServiceManager services = mock(AsgClientServiceManager.class);
    private final AsgClientService service = mock(AsgClientService.class);
    private final K900BluetoothManager bluetooth = mock(K900BluetoothManager.class);
    private VersionCommandHandler handler;

    @Before
    public void setUp() {
        when(services.getService()).thenReturn(service);
        when(services.getBluetoothManager()).thenReturn(bluetooth);
        handler = new VersionCommandHandler(services);
    }

    private JSONObject request(boolean fresh) throws Exception {
        return new JSONObject().put("request_id", "query-one").put("fresh_bes", fresh);
    }

    @Test
    public void freshQueryProbesOnceBeforeSendingTheUnchangedCorrelatedReply() throws Exception {
        when(bluetooth.requestSystemVersionRefresh()).thenReturn(true);

        assertThat(handler.handleCommand("request_version", request(true))).isTrue();

        InOrder order = inOrder(bluetooth, service);
        order.verify(bluetooth).requestSystemVersionRefresh();
        order.verify(service).sendVersionInfo("query-one");
        verifyNoMoreInteractions(bluetooth, service);
    }

    @Test
    public void refusedProbeDoesNotRetryOrClaimThatCachedVersionReplyIsFresh() throws Exception {
        when(bluetooth.requestSystemVersionRefresh()).thenReturn(false);

        assertThat(handler.handleCommand("request_version", request(true))).isTrue();

        verify(bluetooth).requestSystemVersionRefresh();
        verify(service).sendVersionInfo("query-one");
        verifyNoMoreInteractions(bluetooth, service);
    }

    @Test
    public void omittedOrFalseFlagAndAliasDoNotProbe() throws Exception {
        assertThat(handler.handleCommand("request_version", new JSONObject())).isTrue();
        assertThat(handler.handleCommand("request_version", request(false))).isTrue();
        assertThat(handler.handleCommand("cs_syvr", request(true))).isTrue();

        verify(bluetooth, never()).requestSystemVersionRefresh();
        verify(service).sendVersionInfo(null);
        verify(service, org.mockito.Mockito.times(2)).sendVersionInfo("query-one");
        verifyNoMoreInteractions(bluetooth, service);
    }

    @Test
    public void otherTransportReturnsExistingVersionWithoutK900SideEffects() throws Exception {
        ICompanionTransport other = mock(ICompanionTransport.class);
        when(services.getBluetoothManager()).thenReturn(other);

        assertThat(handler.handleCommand("request_version", request(true))).isTrue();

        verify(service).sendVersionInfo("query-one");
        verifyNoMoreInteractions(other);
    }

    @Test
    public void missingServiceAndUnsupportedCommandCannotStartAProbe() throws Exception {
        when(services.getService()).thenReturn(null);

        assertThat(handler.handleCommand("request_version", request(true))).isFalse();
        assertThat(handler.handleCommand("unsupported", request(true))).isFalse();

        verifyNoMoreInteractions(bluetooth, service);
    }
}
