package com.mentra.asg_client.service.core.handlers;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.content.Context;

import com.mentra.asg_client.io.bes.log.BesCrashDumpCollector;
import com.mentra.asg_client.io.bes.log.BesLogTransferLock;
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
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** sr_log routing and the mh_logs wait behind a crash pull (OS-1988 transfer lock). */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class K900CommandHandlerLogRoutingTest {
    private ICompanionTransport mTransport;
    private BesCrashDumpCollector mCollector;
    private K900CommandHandler mHandler;
    private Context mContext;

    @Before
    public void setUp() {
        BesLogTransferLock.get().resetForTest();
        mCollector = mock(BesCrashDumpCollector.class);
        BesCrashDumpCollector.setInstanceForTest(mCollector);
        mTransport = mock(ICompanionTransport.class);
        when(mTransport.isConnected()).thenReturn(true);
        when(mTransport.sendMessage(any(byte[].class))).thenReturn(true);
        AsgClientServiceManager serviceManager = mock(AsgClientServiceManager.class);
        when(serviceManager.getBluetoothManager()).thenReturn(mTransport);
        mHandler = new K900CommandHandler(serviceManager, mock(IStateManager.class),
                mock(ICommunicationManager.class), mock(IPeripheralBus.class));
        mContext = RuntimeEnvironment.getApplication();
    }

    @After
    public void tearDown() {
        BesCrashDumpCollector.setInstanceForTest(null);
        BesLogTransferLock.get().resetForTest();
    }

    private static JSONObject srLog(int cur, String body) throws Exception {
        return new JSONObject().put("C", "sr_log")
                .put("B", new JSONObject().put("cur", cur).put("body", body));
    }

    private void requestRelay(AtomicReference<String> relayed, CountDownLatch done) {
        mHandler.requestBesLogs("rep_1", mContext, mock(IConfigurationManager.class), json -> {
            relayed.set(json);
            done.countDown();
        });
    }

    @Test
    public void srLogGoesToTheCollectorWhileACrashPullOwnsTheChannel() throws Exception {
        assertTrue(BesLogTransferLock.get().acquire(BesLogTransferLock.Owner.CRASH_CS_LOG, 0));
        mHandler.processK900Command(srLog(0, "[CRASH-DUMP] v=1 dump_id=none len=0 crc=00000000"));
        mHandler.processK900Command(srLog(255, "end"));
        verify(mCollector).onLogPacket(eq(0), eq("[CRASH-DUMP] v=1 dump_id=none len=0 crc=00000000"));
        verify(mCollector).onLogPacket(255, "end");
    }

    @Test
    public void srLogWithNoOwnerAndNoSessionIsIgnored() throws Exception {
        mHandler.processK900Command(srLog(1, "stray"));
        verify(mCollector, never()).onLogPacket(anyInt(), any());
    }

    @Test
    public void userMhLogsSessionStillReceivesItsPacketsAndReleasesTheChannel() throws Exception {
        AtomicReference<String> relayed = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        requestRelay(relayed, done);
        verify(mTransport).sendMessage(any(byte[].class));
        assertEquals(BesLogTransferLock.Owner.USER_MH_LOGS, BesLogTransferLock.get().current());

        mHandler.processK900Command(srLog(1, "line one\nline two\n"));
        mHandler.processK900Command(srLog(255, "end"));
        assertTrue(done.await(3, TimeUnit.SECONDS));
        assertTrue(relayed.get().contains("line one"));
        assertTrue(relayed.get().contains("line two"));
        assertNull(BesLogTransferLock.get().current());
        verify(mCollector, never()).onLogPacket(anyInt(), any());
    }

    @Test
    public void bugReportDuringACrashPullWaitsAndThenRunsInsteadOfBeingDropped() throws Exception {
        assertTrue(BesLogTransferLock.get().acquire(BesLogTransferLock.Owner.CRASH_CS_LOG, 0));
        AtomicReference<String> relayed = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        requestRelay(relayed, done);

        Thread.sleep(200);
        verify(mTransport, never()).sendMessage(any(byte[].class)); // mh_logs not sent yet
        assertEquals(1, done.getCount());
        assertNull(relayed.get());

        BesLogTransferLock.get().release(BesLogTransferLock.Owner.CRASH_CS_LOG); // the pull ended
        verify(mTransport, timeout(3000)).sendMessage(any(byte[].class));
        assertEquals(BesLogTransferLock.Owner.USER_MH_LOGS, BesLogTransferLock.get().current());
        mHandler.processK900Command(srLog(1, "after the pull\n"));
        mHandler.processK900Command(srLog(255, "end"));
        assertTrue(done.await(3, TimeUnit.SECONDS));
        assertTrue(relayed.get().contains("after the pull"));
        assertNull(BesLogTransferLock.get().current());
    }

    @Test
    public void failedMhLogsSendFreesTheChannelAndRelaysAnEmptyBody() throws Exception {
        when(mTransport.sendMessage(any(byte[].class))).thenReturn(false);
        AtomicReference<String> relayed = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        requestRelay(relayed, done);
        assertTrue(done.await(3, TimeUnit.SECONDS));
        assertTrue(relayed.get().contains("\"entries\":[]"));
        assertNull(BesLogTransferLock.get().current());
    }
}
