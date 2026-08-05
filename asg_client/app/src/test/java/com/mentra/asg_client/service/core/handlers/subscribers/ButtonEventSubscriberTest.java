package com.mentra.asg_client.service.core.handlers.subscribers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.mentra.asg_client.audio.AudioAssets;
import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.io.bluetooth.managers.K900BluetoothManager;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.LinkStateMachine;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.io.media.core.MediaCaptureService;
import com.mentra.asg_client.io.peripheral.events.ButtonEvent;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import com.mentra.asg_client.settings.AsgSettings;
import java.util.ArrayDeque;
import java.util.Queue;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Local-capture gating on the BES-reported phone BLE presence tri-state: PRESENT defers to the
 * phone; ABSENT and UNKNOWN (old BES firmware) fall back to local capture — the safe default is a
 * possible duplicate photo, never a lost one.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class ButtonEventSubscriberTest {

    private AsgClientServiceManager serviceManager;
    private MediaCaptureService captureService;
    private K900BluetoothManager bluetoothManager;
    private LinkStateMachine linkState;
    private IHardwareManager hardwareManager;
    private Queue<Runnable> batteryTasks;
    private ButtonEventSubscriber subscriber;

    @Before
    public void setUp() {
        serviceManager = mock(AsgClientServiceManager.class);
        captureService = mock(MediaCaptureService.class);
        bluetoothManager = mock(K900BluetoothManager.class);
        hardwareManager = mock(IHardwareManager.class);
        batteryTasks = new ArrayDeque<>();
        AsgSettings asgSettings = mock(AsgSettings.class);
        linkState = new LinkStateMachine();

        when(serviceManager.getAsgSettings()).thenReturn(asgSettings);
        when(serviceManager.getMediaCaptureService()).thenReturn(captureService);
        when(serviceManager.getBluetoothManager()).thenReturn(bluetoothManager);
        when(bluetoothManager.getLinkStateMachine()).thenReturn(linkState);
        // Keep the forward-to-phone path inert; this suite only exercises the capture gate.
        when(bluetoothManager.isConnected()).thenReturn(false);
        when(asgSettings.isSaveInGalleryMode()).thenReturn(false);
        when(asgSettings.getButtonPhotoSize()).thenReturn("medium");
        when(captureService.isRecordingVideo()).thenReturn(false);

        subscriber =
                new ButtonEventSubscriber(
                        serviceManager,
                        hardwareManager,
                        mock(IStateManager.class),
                        batteryTasks::add);
    }

    private void shortPress() {
        subscriber.onMcuEvent(new ButtonEvent(ButtonEvent.Type.CAMERA_SHORT_PRESS));
    }

    private void powerShortPress() {
        subscriber.onMcuEvent(new ButtonEvent(ButtonEvent.Type.POWER_SHORT_PRESS));
    }

    @Test
    public void powerPress_releasesUartCallbackBeforeQueryingBattery() {
        when(hardwareManager.supportsAudioPlayback()).thenReturn(true);
        when(hardwareManager.getBatteryLevel()).thenReturn(100);

        powerShortPress();

        verify(hardwareManager, never()).getBatteryLevel();
        assertThat(batteryTasks).hasSize(1);

        batteryTasks.remove().run();
        verify(hardwareManager).playAudioAsset(AudioAssets.getBatteryLevelAsset(100));
    }

    @Test
    public void interruptedBatteryQuery_doesNotStartAudioDuringShutdown() {
        when(hardwareManager.supportsAudioPlayback()).thenReturn(true);
        when(hardwareManager.getBatteryLevel())
                .thenAnswer(
                        invocation -> {
                            Thread.currentThread().interrupt();
                            return 100;
                        });

        powerShortPress();
        try {
            batteryTasks.remove().run();
            verify(hardwareManager, never()).playAudioAsset(anyString());
        } finally {
            Thread.interrupted();
        }
    }

    @Test
    public void phonePresent_skipsLocalCapture() {
        linkState.serialReady();
        linkState.phonePresenceReported(true);

        shortPress();

        verify(captureService, never()).takePhotoLocally(anyString(), anyBoolean(), anyBoolean());
    }

    @Test
    public void phoneAbsent_capturesLocally() {
        linkState.serialReady();
        linkState.phonePresenceReported(false);

        shortPress();

        verify(captureService).takePhotoLocally(anyString(), anyBoolean(), anyBoolean());
    }

    @Test
    public void presenceUnknown_capturesLocally() {
        // Old BES firmware never reports presence — UNKNOWN must behave like "no phone".
        shortPress();

        verify(captureService).takePhotoLocally(anyString(), anyBoolean(), anyBoolean());
    }

    @Test
    public void presenceUnknownAfterSerialClose_capturesLocally() {
        linkState.serialReady();
        linkState.phonePresenceReported(true);
        linkState.serialClosed();

        shortPress();

        verify(captureService).takePhotoLocally(anyString(), anyBoolean(), anyBoolean());
    }

    @Test
    public void galleryModeActive_capturesLocallyEvenWithPhonePresent() {
        when(serviceManager.getAsgSettings().isSaveInGalleryMode()).thenReturn(true);
        linkState.serialReady();
        linkState.phonePresenceReported(true);

        shortPress();

        verify(captureService).takePhotoLocally(anyString(), anyBoolean(), anyBoolean());
    }

    @Test
    public void nonK900Transport_treatedAsUnknown_capturesLocally() {
        when(serviceManager.getBluetoothManager()).thenReturn(mock(ICompanionTransport.class));

        shortPress();

        verify(captureService).takePhotoLocally(anyString(), anyBoolean(), anyBoolean());
    }
}
