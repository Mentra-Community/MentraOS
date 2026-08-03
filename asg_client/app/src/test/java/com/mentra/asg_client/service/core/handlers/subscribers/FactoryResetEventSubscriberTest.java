package com.mentra.asg_client.service.core.handlers.subscribers;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.mockStatic;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
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
import com.mentra.asg_client.io.peripheral.events.McuEvent;
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
 * download. Also verifies active recordings are stopped first, duplicate events are ignored, and
 * non-FactoryResetEvents are no-ops.
 *
 * <p>The OTA helper is injected (matching production wiring) and local-APK presence is injected via
 * the package-private {@link FactoryResetEventSubscriber.LocalApkChecker} seam, rather than mocking
 * {@link java.io.File} construction globally (which corrupts Robolectric's own file I/O and breaks
 * unrelated tests).
 */
@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class FactoryResetEventSubscriberTest {

    private Application app;
    private AsgClientServiceManager serviceManager;
    private OtaHelper otaHelper;

    @Before
    public void setUp() {
        app = ApplicationProvider.getApplicationContext();
        serviceManager = mock(AsgClientServiceManager.class);
        otaHelper = mock(OtaHelper.class);
        when(serviceManager.getContext()).thenReturn(app);
    }

    /** Build a subscriber whose APK checker reports the given paths as installable. */
    private FactoryResetEventSubscriber subscriberWithInstallable(String... installablePaths) {
        Set<String> installable = new HashSet<>();
        Collections.addAll(installable, installablePaths);
        return new FactoryResetEventSubscriber(
                serviceManager,
                app,
                otaHelper,
                (ctx, path) -> installable.contains(path),
                // No-op downloader for unit tests — avoids real network I/O.
                (ctx, helper) -> {});
    }

    /** Deliver the event and advance the main looper past the pre-install delay. */
    private void deliverAndSettle(FactoryResetEventSubscriber subscriber, McuEvent event) {
        subscriber.onMcuEvent(event);
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(500));
    }

    @Test
    public void nonFactoryResetEvent_isNoOp()  {
        try (MockedStatic<OtaHelper> ota = mockStatic(OtaHelper.class)) {
            FactoryResetEventSubscriber subscriber = subscriberWithInstallable();

            subscriber.onMcuEvent(new ShutdownEvent());
            shadowOf(Looper.getMainLooper()).idle();

            ota.verifyNoInteractions();
            verifyNoInteractions(otaHelper);
            verify(serviceManager, never()).getMediaCaptureService();
        }
    }

    @Test
    public void stagedUpdateApk_installsLocallyWithoutDownloading()  {
        try (MockedStatic<OtaHelper> ota = mockStatic(OtaHelper.class)) {
            ota.when(
                            () ->
                                    OtaHelper.installApk(
                                            any(Context.class),
                                            eq(OtaConstants.ASG_UPDATE_APK_PATH)))
                    .thenReturn(true);

            FactoryResetEventSubscriber subscriber =
                    subscriberWithInstallable(OtaConstants.ASG_UPDATE_APK_PATH);
            deliverAndSettle(subscriber, new FactoryResetEvent());

            ota.verify(
                    () ->
                            OtaHelper.installApk(
                                    any(Context.class), eq(OtaConstants.ASG_UPDATE_APK_PATH)));
            verify(otaHelper, never()).reinstallApkFromBackup();
            verify(otaHelper, never()).startOtaFromPhone(any());
        }
    }

    @Test
    public void stagedApkInstallFails_fallsBackToBackup()  {
        try (MockedStatic<OtaHelper> ota = mockStatic(OtaHelper.class)) {
            ota.when(
                            () ->
                                    OtaHelper.installApk(
                                            any(Context.class),
                                            eq(OtaConstants.ASG_UPDATE_APK_PATH)))
                    .thenReturn(false);
            ota.when(
                            () ->
                                    OtaHelper.installApk(
                                            any(Context.class),
                                            eq(OtaConstants.BACKUP_APK_PATH)))
                    .thenReturn(true);

            FactoryResetEventSubscriber subscriber =
                    subscriberWithInstallable(
                            OtaConstants.ASG_UPDATE_APK_PATH, OtaConstants.BACKUP_APK_PATH);
            deliverAndSettle(subscriber, new FactoryResetEvent());

            ota.verify(
                    () ->
                            OtaHelper.installApk(
                                    any(Context.class), eq(OtaConstants.ASG_UPDATE_APK_PATH)));
            ota.verify(
                    () ->
                            OtaHelper.installApk(
                                    any(Context.class), eq(OtaConstants.BACKUP_APK_PATH)));
            verify(otaHelper, never()).reinstallApkFromBackup();
            verify(otaHelper, never()).startOtaFromPhone(any());
        }
    }

    @Test
    public void noStagedApk_butBackupApk_installsFromBackupDirectly()  {
        try (MockedStatic<OtaHelper> ota = mockStatic(OtaHelper.class)) {
            ota.when(
                            () ->
                                    OtaHelper.installApk(
                                            any(Context.class),
                                            eq(OtaConstants.BACKUP_APK_PATH)))
                    .thenReturn(true);

            FactoryResetEventSubscriber subscriber =
                    subscriberWithInstallable(OtaConstants.BACKUP_APK_PATH);
            deliverAndSettle(subscriber, new FactoryResetEvent());

            ota.verify(
                    () ->
                            OtaHelper.installApk(
                                    any(Context.class), eq(OtaConstants.BACKUP_APK_PATH)));
            verify(otaHelper, never()).reinstallApkFromBackup();
            verify(otaHelper, never()).startOtaFromPhone(any());
        }
    }

    @Test
    public void noLocalApk_invokesRecoveryDownloader()  {
        FactoryResetEventSubscriber.RecoveryDownloader mockDownloader =
                mock(FactoryResetEventSubscriber.RecoveryDownloader.class);
        FactoryResetEventSubscriber subscriber =
                new FactoryResetEventSubscriber(
                        serviceManager, app, otaHelper,
                        (ctx, path) -> false,
                        mockDownloader);

        try (MockedStatic<OtaHelper> ota = mockStatic(OtaHelper.class)) {
            deliverAndSettle(subscriber, new FactoryResetEvent());

            verify(mockDownloader).download(any(Context.class), eq(otaHelper));
            ota.verify(() -> OtaHelper.installApk(any(Context.class), any(String.class)), never());
            verify(otaHelper, never()).reinstallApkFromBackup();
        }
    }

    @Test
    public void activeRecording_isStoppedBeforeReset()  {
        MediaCaptureService mediaCaptureService = mock(MediaCaptureService.class);
        when(serviceManager.getMediaCaptureService()).thenReturn(mediaCaptureService);
        when(mediaCaptureService.isRecordingVideo()).thenReturn(true);

        try (MockedStatic<OtaHelper> ota = mockStatic(OtaHelper.class)) {
            FactoryResetEventSubscriber subscriber = subscriberWithInstallable();
            deliverAndSettle(subscriber, new FactoryResetEvent());

            verify(mediaCaptureService).stopVideoRecording();
        }
    }

    @Test
    public void duplicateEvent_whileInProgress_isIgnored()  {
        try (MockedStatic<OtaHelper> ota = mockStatic(OtaHelper.class)) {
            ota.when(
                            () ->
                                    OtaHelper.installApk(
                                            any(Context.class),
                                            eq(OtaConstants.ASG_UPDATE_APK_PATH)))
                    .thenReturn(true);

            FactoryResetEventSubscriber subscriber =
                    subscriberWithInstallable(OtaConstants.ASG_UPDATE_APK_PATH);

            // Two events arrive before the delayed install runs; only the first should be honored.
            subscriber.onMcuEvent(new FactoryResetEvent());
            subscriber.onMcuEvent(new FactoryResetEvent());
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(500));

            ota.verify(
                    () ->
                            OtaHelper.installApk(
                                    any(Context.class), eq(OtaConstants.ASG_UPDATE_APK_PATH)),
                    times(1));
        }
    }
}
