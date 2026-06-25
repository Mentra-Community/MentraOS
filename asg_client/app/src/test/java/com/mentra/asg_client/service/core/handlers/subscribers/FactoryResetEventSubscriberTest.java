package com.mentra.asg_client.service.core.handlers.subscribers;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.mockConstruction;
import static org.mockito.Mockito.mockStatic;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.app.Application;
import android.content.Context;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.io.media.core.MediaCaptureService;
import com.mentra.asg_client.io.ota.helpers.OtaHelper;
import com.mentra.asg_client.io.ota.utils.OtaConstants;
import com.mentra.asg_client.io.peripheral.events.FactoryResetEvent;
import com.mentra.asg_client.io.peripheral.events.ShutdownEvent;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import java.io.File;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.MockedConstruction;
import org.mockito.MockedStatic;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Verifies {@link FactoryResetEventSubscriber} reacts to {@code cs_fcrst} by (re)installing the ASG
 * client APK, preferring a staged local APK, then a backup APK, and finally falling back to an OTA
 * download. Also verifies active recordings are stopped first and non-FactoryResetEvents are ignored.
 */
@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class FactoryResetEventSubscriberTest {

    private Application app;
    private AsgClientServiceManager serviceManager;
    private FactoryResetEventSubscriber subscriber;

    @Before
    public void setUp() {
        app = ApplicationProvider.getApplicationContext();
        serviceManager = mock(AsgClientServiceManager.class);
        when(serviceManager.getContext()).thenReturn(app);
        subscriber = new FactoryResetEventSubscriber(serviceManager, app);
    }

    @Test
    public void nonFactoryResetEvent_isNoOp() {
        try (MockedStatic<OtaHelper> ota = mockStatic(OtaHelper.class)) {
            subscriber.onMcuEvent(new ShutdownEvent());

            ota.verifyNoInteractions();
            verify(serviceManager, never()).getMediaCaptureService();
        }
    }

    @Test
    public void stagedUpdateApk_installsLocallyWithoutDownloading() {
        try (MockedStatic<OtaHelper> ota = mockStatic(OtaHelper.class);
                MockedConstruction<File> files =
                        mockConstruction(
                                File.class,
                                (mockFile, ctx) -> {
                                    when(mockFile.exists()).thenReturn(true);
                                    when(mockFile.canRead()).thenReturn(true);
                                })) {
            ota.when(
                            () ->
                                    OtaHelper.installApk(
                                            any(Context.class),
                                            eq(OtaConstants.ASG_UPDATE_APK_PATH)))
                    .thenReturn(true);

            subscriber.onMcuEvent(new FactoryResetEvent());

            ota.verify(
                    () ->
                            OtaHelper.installApk(
                                    any(Context.class), eq(OtaConstants.ASG_UPDATE_APK_PATH)));
            // Local install kicked off: no singleton lookup / OTA download fallback.
            ota.verify(OtaHelper::getInstance, never());
        }
    }

    @Test
    public void noStagedApk_butBackupApk_reinstallsFromBackup() {
        OtaHelper otaHelper = mock(OtaHelper.class);
        when(otaHelper.reinstallApkFromBackup()).thenReturn(true);

        try (MockedStatic<OtaHelper> ota = mockStatic(OtaHelper.class);
                MockedConstruction<File> files =
                        mockConstruction(
                                File.class,
                                (mockFile, ctx) -> {
                                    String path = (String) ctx.arguments().get(0);
                                    boolean isBackup = OtaConstants.BACKUP_APK_PATH.equals(path);
                                    when(mockFile.exists()).thenReturn(isBackup);
                                    when(mockFile.canRead()).thenReturn(isBackup);
                                })) {
            ota.when(OtaHelper::getInstance).thenReturn(otaHelper);

            subscriber.onMcuEvent(new FactoryResetEvent());

            verify(otaHelper).reinstallApkFromBackup();
            ota.verify(() -> OtaHelper.installApk(any(Context.class), any(String.class)), never());
            verify(otaHelper, never()).startOtaFromPhone();
        }
    }

    @Test
    public void noLocalApk_fallsBackToOtaDownload() {
        OtaHelper otaHelper = mock(OtaHelper.class);

        // No staged/backup APKs exist on the (test) filesystem, so installLocalApk() returns false.
        try (MockedStatic<OtaHelper> ota = mockStatic(OtaHelper.class)) {
            ota.when(OtaHelper::getInstance).thenReturn(otaHelper);

            subscriber.onMcuEvent(new FactoryResetEvent());

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

            subscriber.onMcuEvent(new FactoryResetEvent());

            verify(mediaCaptureService).stopVideoRecording();
        }
    }
}
