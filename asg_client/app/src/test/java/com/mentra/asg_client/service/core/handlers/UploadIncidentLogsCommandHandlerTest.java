package com.mentra.asg_client.service.core.handlers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.app.Application;

import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.system.interfaces.IConfigurationManager;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowLog;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Queue;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

/** Independent incident log sources share one sequential, bounded BLE transport. */
@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class UploadIncidentLogsCommandHandlerTest {
    private final ICompanionTransport bluetooth = mock(ICompanionTransport.class);
    private final AsgClientServiceManager services = mock(AsgClientServiceManager.class);
    private final K900CommandHandler bes = mock(K900CommandHandler.class);
    private final IConfigurationManager configuration = mock(IConfigurationManager.class);
    private final AtomicBoolean active = new AtomicBoolean();
    private final AtomicBoolean connected = new AtomicBoolean(true);
    private final Queue<Boolean> starts = new ArrayDeque<>();
    private final Queue<Boolean> waits = new ArrayDeque<>();
    private final List<Long> deadlines = new ArrayList<>();
    private final List<File> sentFiles = new ArrayList<>();
    private final List<String> sentSources = new ArrayList<>();
    private UploadIncidentLogsCommandHandler handler;

    @Before
    public void setUp() throws Exception {
        when(services.getBluetoothManager()).thenReturn(bluetooth);
        when(bluetooth.isConnected()).thenAnswer(invocation -> connected.get());
        when(bluetooth.isFileTransferInProgress()).thenAnswer(invocation -> active.get());
        doAnswer(
                        invocation -> {
                            Consumer<String> callback = invocation.getArgument(3);
                            callback.accept("{\"source\":\"glasses_firmware\",\"entries\":[]}");
                            return null;
                        })
                .when(bes)
                .requestBesLogs(anyString(), any(), eq(configuration), any(Consumer.class));
        when(bluetooth.sendFile(anyString()))
                .thenAnswer(
                        invocation -> {
                            assertThat(active.get()).as("never overlap file transfers").isFalse();
                            File file = new File(invocation.getArgument(0, String.class));
                            sentFiles.add(file);
                            sentSources.add(
                                    new JSONObject(
                                                    new String(
                                                            Files.readAllBytes(file.toPath()),
                                                            StandardCharsets.UTF_8))
                                            .getString("source"));
                            boolean started = starts.remove();
                            active.set(started);
                            return started;
                        });
        handler =
                spy(
                        new UploadIncidentLogsCommandHandler(
                                RuntimeEnvironment.getApplication(),
                                configuration,
                                bes,
                                null,
                                services));
        // Exercise the real relay control flow without waiting two minutes per timeout case.
        doAnswer(
                        invocation -> {
                            long maxWaitMs = invocation.getArgument(1);
                            deadlines.add(maxWaitMs);
                            if (maxWaitMs == 10_000) {
                                return !active.get();
                            }
                            boolean idle = waits.remove();
                            active.set(!idle);
                            return idle;
                        })
                .when(handler)
                .waitUntilFileTransferIdle(eq(bluetooth), anyLong());
    }

    @Test
    public void refusedFirmwareStartStillSendsIndependentJavaLogsOnce() {
        starts.add(false);
        starts.add(true);
        waits.add(true);

        handler.relayLogsViaBle("rep_refused_firmware");

        assertThat(sentSources).containsExactly("glasses_firmware", "glasses");
        assertThat(deadlines).containsExactly(10_000L, 120_000L);
        assertFilesRemoved();
        assertThat(messages())
                .anyMatch(
                        message ->
                                message.contains("incidentId=rep_refused_firmware")
                                        && message.contains("source=glasses_firmware")
                                        && message.contains("stage=start_refused"));
    }

    @Test
    public void firmwareStartExceptionOnIdleTransportDoesNotSuppressJavaLogs() {
        doAnswer(
                        invocation -> {
                            File file = new File(invocation.getArgument(0, String.class));
                            sentFiles.add(file);
                            if (sentFiles.size() == 1) {
                                throw new IllegalStateException("firmware start failed");
                            }
                            active.set(true);
                            return true;
                        })
                .when(bluetooth)
                .sendFile(anyString());
        waits.add(true);

        handler.relayLogsViaBle("rep_failed_firmware");

        assertThat(sentFiles).hasSize(2);
        assertThat(sentFiles.get(1).getName()).startsWith("L");
        assertFilesRemoved();
        assertThat(messages())
                .anyMatch(
                        message ->
                                message.contains("source=glasses_firmware")
                                        && message.contains("stage=failed"));
    }

    @Test
    public void settledFirmwareAndJavaTransfersRemainSequentialWithoutClaimingUploadAck() {
        starts.add(true);
        starts.add(true);
        waits.add(true);
        waits.add(true);

        handler.relayLogsViaBle("rep_sequence");

        assertThat(sentSources).containsExactly("glasses_firmware", "glasses");
        assertThat(deadlines).containsExactly(10_000L, 120_000L, 120_000L);
        assertFilesRemoved();
        assertThat(messages()).noneMatch(message -> message.contains("sequence completed"));
    }

    @Test
    public void firmwareTimeoutRetainsActiveTransportAndDoesNotStartJava() {
        starts.add(true);
        waits.add(false);

        handler.relayLogsViaBle("rep_busy");

        assertThat(sentSources).containsExactly("glasses_firmware");
        assertThat(active.get()).isTrue();
        assertThat(deadlines).containsExactly(10_000L, 120_000L);
        assertFilesRemoved();
        assertThat(messages())
                .anyMatch(message -> message.contains("stage=wait_expired"))
                .anyMatch(
                        message ->
                                message.contains("source=glasses")
                                        && message.contains("stage=not_started"));
    }

    @Test
    public void freshIdleAfterExpiredWaitAllowsJavaWithoutAnotherFirmwareAttempt()
            throws Exception {
        starts.add(true);
        starts.add(true);
        doAnswer(
                        invocation -> {
                            long maxWaitMs = invocation.getArgument(1);
                            deadlines.add(maxWaitMs);
                            active.set(false);
                            return deadlines.size() != 2;
                        })
                .when(handler)
                .waitUntilFileTransferIdle(eq(bluetooth), anyLong());

        handler.relayLogsViaBle("rep_settled_after_wait");

        assertThat(sentSources).containsExactly("glasses_firmware", "glasses");
        assertThat(deadlines).containsExactly(10_000L, 120_000L, 120_000L);
        assertFilesRemoved();
    }

    @Test
    public void refusedFirmwareStartThatLeavesAnotherTransferActiveDoesNotStartJava() {
        doAnswer(
                        invocation -> {
                            sentFiles.add(new File(invocation.getArgument(0, String.class)));
                            active.set(true);
                            return false;
                        })
                .when(bluetooth)
                .sendFile(anyString());

        handler.relayLogsViaBle("rep_refused_busy");

        assertThat(sentFiles).hasSize(1);
        assertThat(active.get()).isTrue();
        assertThat(deadlines).containsExactly(10_000L);
        assertFilesRemoved();
    }

    @Test
    public void disconnectedTransportAfterFirmwareDoesNotStartJava() throws Exception {
        starts.add(true);
        waits.add(true);
        doAnswer(
                        invocation -> {
                            long maxWaitMs = invocation.getArgument(1);
                            deadlines.add(maxWaitMs);
                            if (maxWaitMs == 120_000) {
                                active.set(false);
                                connected.set(false);
                            }
                            return true;
                        })
                .when(handler)
                .waitUntilFileTransferIdle(eq(bluetooth), anyLong());

        handler.relayLogsViaBle("rep_disconnected");

        assertThat(sentSources).containsExactly("glasses_firmware");
        assertFilesRemoved();
    }

    @Test
    public void existingActiveTransferIsNotClearedOrOverlapped() {
        active.set(true);

        handler.relayLogsViaBle("rep_existing_transfer");

        assertThat(sentFiles).isEmpty();
        assertThat(active.get()).isTrue();
        assertThat(deadlines).containsExactly(10_000L);
    }

    @Test
    public void interruptedFirmwareWaitPreservesInterruptionAndDoesNotStartJava() throws Exception {
        starts.add(true);
        doAnswer(
                        invocation -> {
                            if ((long) invocation.getArgument(1) == 120_000) {
                                throw new InterruptedException("cancel incident relay");
                            }
                            return true;
                        })
                .when(handler)
                .waitUntilFileTransferIdle(eq(bluetooth), anyLong());

        try {
            handler.relayLogsViaBle("rep_interrupted");

            assertThat(Thread.currentThread().isInterrupted()).isTrue();
            assertThat(active.get()).isTrue();
            verify(bluetooth, times(1)).sendFile(anyString());
            assertFilesRemoved();
        } finally {
            Thread.interrupted();
        }
    }

    @Test
    public void actualWaitReturnsExpiredWithoutChangingTransportState() throws Exception {
        active.set(true);
        UploadIncidentLogsCommandHandler real =
                new UploadIncidentLogsCommandHandler(
                        RuntimeEnvironment.getApplication(), configuration, bes, null, services);

        assertThat(real.waitUntilFileTransferIdle(bluetooth, 0)).isFalse();
        assertThat(active.get()).isTrue();
        active.set(false);
        assertThat(real.waitUntilFileTransferIdle(bluetooth, 0)).isTrue();
    }

    @Test
    public void interruptedFirmwareStartupReturningFalseDoesNotSubmitJava() {
        doAnswer(
                        invocation -> {
                            sentFiles.add(new File(invocation.getArgument(0, String.class)));
                            Thread.currentThread().interrupt();
                            return false;
                        })
                .when(bluetooth)
                .sendFile(anyString());

        try {
            handler.relayLogsViaBle("rep_interrupted_start");

            assertThat(Thread.currentThread().isInterrupted()).isTrue();
            assertThat(active.get()).isFalse();
            verify(bluetooth, times(1)).sendFile(anyString());
            assertThat(sentFiles).hasSize(1);
            assertFilesRemoved();
            assertThat(messages())
                    .anyMatch(
                            message ->
                                    message.contains("source=glasses_firmware")
                                            && message.contains("stage=interrupted"));
        } finally {
            Thread.interrupted();
        }
    }

    @Test
    public void alreadyInterruptedRelayNeverSubmitsAFile() {
        try {
            Thread.currentThread().interrupt();
            handler.relayLogsViaBle("rep_already_interrupted");

            assertThat(Thread.currentThread().isInterrupted()).isTrue();
            verify(bluetooth, org.mockito.Mockito.never()).sendFile(anyString());
            assertThat(sentFiles).isEmpty();
        } finally {
            Thread.interrupted();
        }
    }

    private void assertFilesRemoved() {
        assertThat(sentFiles).allMatch(file -> !file.exists());
    }

    private List<String> messages() {
        List<String> messages = new ArrayList<>();
        ShadowLog.getLogsForTag("UploadIncidentLogsHandler")
                .forEach(entry -> messages.add(entry.msg));
        return messages;
    }
}
