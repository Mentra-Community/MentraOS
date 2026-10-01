package com.mentra.asg_client.io.bluetooth.managers;

import static org.junit.Assert.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.BesUartTransportCoordinator;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.LinkStateMachine;
import com.mentra.asg_client.io.bluetooth.utils.DebugNotificationManager;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** Replays the production sender with only UART IO and the clock's scheduling mocked. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class K900FileTransferRecoveryTest {
    private K900BluetoothManager manager;
    private BesUartTransportCoordinator uart;
    private Object session;
    private final List<Runnable> timers = new ArrayList<>();

    @Before public void setUp() throws Exception {
        manager = mock(K900BluetoothManager.class, CALLS_REAL_METHODS);
        uart = mock(BesUartTransportCoordinator.class);
        when(uart.runFileWrite(any(), any())).thenReturn(true);
        set(manager, "transportCoordinator", uart);
        set(manager, "notificationManager", mock(DebugNotificationManager.class));
        set(manager, "linkState", new LinkStateMachine());
        set(manager, "besSupportsBatchedAcks", true);
        set(manager, "pendingPackets", new ConcurrentHashMap<>());
        set(manager, "pendingFailureRetryIndex", -1);
        ScheduledExecutorService executor = mock(ScheduledExecutorService.class);
        when(executor.schedule(any(Runnable.class), anyLong(), any(TimeUnit.class)))
                .thenAnswer(invocation -> {
                    timers.add(invocation.getArgument(0));
                    return mock(ScheduledFuture.class);
                });
        set(manager, "fileTransferExecutor", executor);
        session = newSession();
        set(manager, "currentFileTransfer", session);
    }

    private Object newSession() throws Exception {
        Class<?> type = Class.forName(K900BluetoothManager.class.getName() + "$FileTransferSession");
        Constructor<?> constructor = type.getDeclaredConstructors()[0];
        constructor.setAccessible(true);
        return constructor.newInstance(mock(BesUartTransportCoordinator.OperationLease.class),
                null, "photo.jpg", new byte[160000], 800, true);
    }

    private void atReportedStall() throws Exception {
        set(session, "currentPacketIndex", 120);
        set(session, "highestSentIndex", 119);
        set(session, "highestAckedIndex", 111);
        for (int i = 112; i < 120; i++) invoke("sendFilePacketAt", new Class<?>[]{int.class}, i);
        clearInvocations(uart);
    }

    @Test public void nak120SendsBoundedRecoveryBatchWithoutForgingAnAck() throws Exception {
        atReportedStall();
        List<Runnable> oldTimers = new ArrayList<>(timers);
        manager.handleFileTransferAck(0, 120);
        Runnable recovery = timers.get(timers.size() - 1);
        for (Runnable timer : oldTimers) timer.run();
        verify(uart, never()).runFileWrite(any(), any());
        recovery.run();
        verify(uart, times(8)).runFileWrite(any(), any());
        assertEquals(128, get(session, "currentPacketIndex"));
        assertEquals(111, get(session, "highestAckedIndex"));
        manager.handleFileTransferAck(1, 128);
        assertEquals(127, get(session, "highestAckedIndex"));
        verify(uart, times(16)).runFileWrite(any(), any());
    }

    @Test public void oldRecoveryCannotMutateReplacementPhoto() throws Exception {
        atReportedStall();
        manager.handleFileTransferAck(0, 120);
        Runnable oldRecovery = timers.get(timers.size() - 1);
        session = newSession();
        set(manager, "currentFileTransfer", session);
        set(session, "highestSentIndex", 119);
        set(session, "currentPacketIndex", 120);
        set(manager, "failureRetryScheduled", false);
        manager.handleFileTransferAck(0, 120);
        oldRecovery.run();
        verify(uart, never()).runFileWrite(any(), any());
        assertEquals(true, get(manager, "failureRetryScheduled"));
    }

    @Test public void impossibleAckCannotCompleteOrMoveTransfer() throws Exception {
        set(session, "highestSentIndex", 7);
        set(session, "currentPacketIndex", 8);
        manager.handleFileTransferAck(1, 200);
        manager.handleFileTransferAck(0, 201);
        manager.handleFileTransferAck(7, 4);
        assertEquals(-1, get(session, "highestAckedIndex"));
        assertEquals(8, get(session, "currentPacketIndex"));
        assertTrue(timers.isEmpty());
    }

    @Test public void wrongFilenameCannotEnterPhoneConfirmationState() throws Exception {
        set(session, "highestSentIndex", 199);
        manager.handlePhoneConfirmation("other.jpg", true);
        assertEquals(false, get(session, "waitingForPhoneConfirmation"));
        assertSame(session, get(manager, "currentFileTransfer"));
    }

    @Test public void successDuringBackoffDoesNotResendAlreadyAcknowledgedPackets() throws Exception {
        set(session, "highestSentIndex", 127);
        set(session, "currentPacketIndex", 128);
        set(session, "highestAckedIndex", 111);
        manager.handleFileTransferAck(0, 120);
        Runnable recovery = timers.get(0);
        manager.handleFileTransferAck(1, 128);
        assertEquals(136, get(session, "currentPacketIndex"));
        verify(uart, times(8)).runFileWrite(any(), any());
        recovery.run();
        verify(uart, times(8)).runFileWrite(any(), any());
    }

    @Test public void wholePhotoRetryInvalidatesOldRecoveryAndRestartsAtZero() throws Exception {
        atReportedStall();
        manager.handleFileTransferAck(0, 120);
        Runnable oldRecovery = timers.get(timers.size() - 1);
        set(session, "highestSentIndex", 199);
        set(session, "waitingForPhoneConfirmation", true);
        manager.handlePhoneConfirmation("photo.jpg", false);
        assertEquals(8, get(session, "currentPacketIndex"));
        assertEquals(-1, get(session, "highestAckedIndex"));
        assertEquals(false, get(manager, "failureRetryScheduled"));
        verify(uart, times(8)).runFileWrite(any(), any());
        oldRecovery.run();
        verify(uart, times(8)).runFileWrite(any(), any());
    }

    private Object invoke(String name, Class<?>[] types, Object... args) throws Exception {
        Method method = K900BluetoothManager.class.getDeclaredMethod(name, types);
        method.setAccessible(true);
        return method.invoke(manager, args);
    }
    private static Field field(Object target, String name) throws Exception {
        Class<?> type = target instanceof K900BluetoothManager ? K900BluetoothManager.class : target.getClass();
        Field field = type.getDeclaredField(name);
        field.setAccessible(true);
        return field;
    }
    private static void set(Object target, String name, Object value) throws Exception { field(target,name).set(target,value); }
    private static Object get(Object target, String name) throws Exception { return field(target,name).get(target); }
}
