package com.mentra.asg_client.service.core.handlers.subscribers;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.mockStatic;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.robolectric.Shadows.shadowOf;

import android.app.Application;
import android.content.Context;
import android.os.Looper;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.io.media.core.MediaCaptureService;
import com.mentra.asg_client.io.ota.helpers.OtaHelper;
import com.mentra.asg_client.io.ota.utils.OtaConstants;
import com.mentra.asg_client.io.peripheral.events.FactoryResetEvent;
import com.mentra.asg_client.io.peripheral.events.ShutdownEvent;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import java.time.Duration;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.MockedStatic;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Verifies {@link FactoryResetEventSubscriber} reacts to {@code cs_fcrst} by (re)installing the ASG
 * client APK, preferring a staged local APK, then a backup APK, and finally falling back to an OTA
 * download. Also verifies active recordings are stopped first and non-FactoryResetEvents are
 * ignored.
 *
 * <p>File presence is injected via the package-private {@link
 * FactoryResetEventSubscriber.FileReadableChecker} seam rather than mocking {@link java.io.File}
 * construction globally (which corrupts Robolectric's own file I/O and breaks unrelated tests).
 */
@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class FactoryResetEventSubscriberTest {

    private Application app;
    private AsgClientServiceManager serviceManager;

    @Before
    public void setUp() {
        app = ApplicationProvider.getApplicationContext();
        serviceManager = mock(AsgClientServiceManager.class);
        when(serviceManager.getContext()).thenReturn(app);
    }

    /** Build a subscriber whose local-APK checker reports the given paths as present + readable. */
    private FactoryResetEventSubscriber subscriberWithReadable(String... readablePaths) {
        Set<String> readable = new HashSet<>();
        Collections.addAll(readable, readablePaths);
        return new FactoryResetEventSubscriber(serviceManager, app, readable::contains);
    }

    /** Deliver the event and advance the main looper past the pre-install delay. */
    private void deliverAndSettle(
            FactoryResetEventSubscriber subscriber,
            com.mentra.asg_client.io.peripheral.events.McuEvent event) {
        subscriber.onMcuEvent(event);
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(500));
    }

    @Test
    public void nonFactoryResetEvent_isNoOp() {
        try (MockedStatic<OtaHelper> ota = mockStatic(OtaHelper.class)) {
            FactoryResetEventSubscriber subscriber = subscriberWithReadable();

            subscriber.onMcuEvent(new ShutdownEvent());
            shadowOf(Looper.getMainLooper()).idle();

            ota.verifyNoInteractions();
            verify(serviceManager, never()).getMediaCaptureService();
        }
    }

    @Test
    public void stagedUpdateApk_installsLocallyWithoutDownloading() {
        try (MockedStatic<OtaHelper> ota = mockStatic(OtaHelper.class)) {
            ota.when(
                            () ->
                                    OtaHelper.installApk(
                                            any(Context.class),
                                            eq(OtaConstants.ASG_UPDATE_APK_PATH)))
                    .thenReturn(true);

            FactoryResetEventSubscriber subscriber =
                    subscriberWithReadable(OtaConstants.ASG_UPDATE_APK_PATH);
            deliverAndSettle(subscriber, new FactoryResetEvent());

            ota.verify(
                    () ->
                            OtaHelper.installApk(
                                    any(Context.class), eq(OtaConstants.ASG_UPDATE_APK_PATH)));
            // Local install kicked off: no singleton lookup / OTA download fallback.
            ota.verify(OtaHelper::getInstance, never());
        }
    }

    @Test
    public void stagedApkInstallFails_fallsBackToBackup() {
        OtaHelper otaHelper = mock(OtaHelper.class);
        when(otaHelper.reinstallApkFromBackup()).thenReturn(true);

        try (MockedStatic<OtaHelper> ota = mockStatic(OtaHelper.class)) {
            ota.when(
                            () ->
                                    OtaHelper.installApk(
                                            any(Context.class),
                                            eq(OtaConstants.ASG_UPDATE_APK_PATH)))
                    .thenReturn(false);
            ota.when(OtaHelper::getInstance).thenReturn(otaHelper);

            FactoryResetEventSubscriber subscriber =
                    subscriberWithReadable(
                            OtaConstants.ASG_UPDATE_APK_PATH, OtaConstants.BACKUP_APK_PATH);
            deliverAndSettle(subscriber, new FactoryResetEvent());

            ota.verify(
                    () ->
                            OtaHelper.installApk(
                                    any(Context.class), eq(OtaConstants.ASG_UPDATE_APK_PATH)));
            verify(otaHelper).reinstallApkFromBackup();
            verify(otaHelper, never()).startOtaFromPhone();
        }
    }

    @Test
    public void noStagedApk_butBackupApk_reinstallsFromBackup() {
        OtaHelper otaHelper = mock(OtaHelper.class);
        when(otaHelper.reinstallApkFromBackup()).thenReturn(true);

        try (MockedStatic<OtaHelper> ota = mockStatic(OtaHelper.class)) {
            ota.when(OtaHelper::getInstance).thenReturn(otaHelper);

            FactoryResetEventSubscriber subscriber =
                    subscriberWithReadable(OtaConstants.BACKUP_APK_PATH);
            deliverAndSettle(subscriber, new FactoryResetEvent());

            verify(otaHelper).reinstallApkFromBackup();
            ota.verify(() -> OtaHelper.installApk(any(Context.class), any(String.class)), never());
            verify(otaHelper, never()).startOtaFromPhone();
        }
    }

    @Test
    public void noLocalApk_fallsBackToOtaDownload() {
        OtaHelper otaHelper = mock(OtaHelper.class);

        // No staged/backup APKs are reported readable, so installLocalApk() returns false.
        try (MockedStatic<OtaHelper> ota = mockStatic(OtaHelper.class)) {
            ota.when(OtaHelper::getInstance).thenReturn(otaHelper);

            FactoryResetEventSubscriber subscriber = subscriberWithReadable();
            deliverAndSettle(subscriber, new FactoryResetEvent());

            verify(otaHelper).startOtaFromPhone();
            ota.verify(() -> OtaHelper.installApk(any(Context.class), any(String.class)), never());
            verify(otaHelper, never()).reinstallApkFromBackup();
        }
    }

    @Test
    public void activeRecording_isStoppedBeforeReset() {
        MediaCaptureService mediaCaptureService = mock(MediaCaptureService.class);
        when(serviceManager.getMediaCaptureService()).thenReturn(mediaCaptureService);
        when(mediaCaptureService.isRecordingVideo()).thenReturn(true);

        try (MockedStatic<OtaHelper> ota = mockStatic(OtaHelper.class)) {
            ota.when(OtaHelper::getInstance).thenReturn(mock(OtaHelper.class));

            FactoryResetEventSubscriber subscriber = subscriberWithReadable();
            deliverAndSettle(subscriber, new FactoryResetEvent());

            verify(mediaCaptureService).stopVideoRecording();
        }
    }
}
