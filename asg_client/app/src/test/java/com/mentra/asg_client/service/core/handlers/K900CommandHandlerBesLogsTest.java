package com.mentra.asg_client.service.core.handlers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.mockito.ArgumentMatchers.any;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;

import com.mentra.asg_client.io.bes.log.BesTraceStore;
import com.mentra.asg_client.io.bes.log.BesTraceTail;
import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.io.peripheral.IPeripheralBus;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.system.interfaces.IConfigurationManager;
import com.mentra.asg_client.service.system.interfaces.IStateManager;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.Arrays;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Bug reports use the delivered TRACE store when the BES supports mh_rlog, mh_logs otherwise. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class K900CommandHandlerBesLogsTest {
    private Context mContext;
    private ICompanionTransport mBluetooth;
    private K900CommandHandler mHandler;

    @Before
    public void setUp() {
        mContext = ApplicationProvider.getApplicationContext();
        BesTraceTail.get().resetForTest();
        AsgClientServiceManager serviceManager = mock(AsgClientServiceManager.class);
        mBluetooth = mock(ICompanionTransport.class);
        when(serviceManager.getBluetoothManager()).thenReturn(mBluetooth);
        when(mBluetooth.isConnected()).thenReturn(true);
        when(mBluetooth.sendMessage(any())).thenReturn(true);
        mHandler = new K900CommandHandler(serviceManager, mock(IStateManager.class),
                mock(ICommunicationManager.class), mock(IPeripheralBus.class));
    }

    @After
    public void tearDown() {
        BesTraceTail.get().resetForTest();
    }

    private String relay() throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> json = new AtomicReference<>();
        mHandler.requestBesLogs("rep_1", mContext, mock(IConfigurationManager.class), value -> {
            json.set(value);
            done.countDown();
        });
        done.await(5, TimeUnit.SECONDS);
        return json.get();
    }

    @Test
    public void supportedFirmwareRelaysTheStoreWithoutUartTraffic() throws Exception {
        BesTraceTail.get().attach(mContext);
        BesTraceTail.get().setSupported(true);
        long now = System.currentTimeMillis();
        BesTraceTail.get().store().append(Arrays.asList(
                new BesTraceStore.Line(now - 60_000, 5, 0, "[PWR] earlier"),
                new BesTraceStore.Line(now, 5, 20, "[SPK-TONE] now")));

        JSONObject body = new JSONObject(relay());

        assertThat(body.getString("source")).isEqualTo("glasses_firmware");
        assertThat(body.getJSONArray("entries").length()).isEqualTo(2);
        assertThat(body.getJSONArray("entries").getJSONObject(0).getLong("timestamp"))
                .isEqualTo(now - 60_000);
        verify(mBluetooth, never()).sendMessage(any());
    }

    @Test
    public void olderFirmwareStillRequestsAnMhLogsDump() {
        mHandler.requestBesLogs("rep_1", mContext, mock(IConfigurationManager.class), value -> {});
        verify(mBluetooth).sendMessage(any());
        assertThat(mHandler.hasActiveBesLogSession()).isTrue();
    }
}
