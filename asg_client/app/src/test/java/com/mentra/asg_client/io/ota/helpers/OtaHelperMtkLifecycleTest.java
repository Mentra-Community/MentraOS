package com.mentra.asg_client.io.ota.helpers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;
import static org.robolectric.Shadows.shadowOf;

import android.content.Context;
import android.content.Intent;
import android.os.Looper;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaRegistry;
import com.mentra.asg_client.io.ota.receivers.MtkOtaReceiver;
import com.mentra.asg_client.io.ota.utils.OtaConstants;
import com.mentra.asg_client.io.ota.utils.FirmwareDownloadException;
import com.mentra.asg_client.AsgConstants;
import org.junit.Assert;
import com.mentra.asg_client.service.system.core.SystemControllerFactory;
import com.mentra.asg_client.service.system.interfaces.ISystemController;
import java.lang.reflect.Method;
import java.time.Duration;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.ArgumentCaptor;
import org.mockito.MockedStatic;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** Regression tests for real transfer progress and system-updater ownership. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class OtaHelperMtkLifecycleTest {
    private OtaHelper original;
    private OtaHelper helper;

    private OtaHelper createHelper() {
        original = new OtaHelper(ApplicationProvider.getApplicationContext(), mock(IBesOtaRegistry.class));
        helper = spy(original);
        return helper;
    }

    @After public void cleanup() {
        if (helper != null) helper.getSessionManager().clear();
        if (helper != null) helper.cleanup();
        if (original != null) original.cleanup();
        OtaHelper.setMtkOtaInProgress(false);
        OtaHelper.clearMtkSessionFlag();
    }

    @Test public void elapsedTimeCannotReleaseSystemInstallOrPermitReplacementDownload() throws Exception {
        createHelper();
        helper.setPhoneInitiatedOta(true);
        doReturn(true).when(helper).downloadMtkFirmware(anyString(), any(), any());
        ISystemController system = mock(ISystemController.class);
        Context context = ApplicationProvider.getApplicationContext();
        JSONObject firmware = new JSONObject().put("end_firmware", "20260908.0").put("url", "https://cdn/full.zip");
        Method install = OtaHelper.class.getDeclaredMethod("checkAndUpdateMtkFirmware", JSONObject.class, Context.class);
        install.setAccessible(true);
        try (MockedStatic<SystemControllerFactory> factory = mockStatic(SystemControllerFactory.class)) {
            factory.when(() -> SystemControllerFactory.get(any())).thenReturn(system);
            assertThat(install.invoke(helper, firmware, context)).isEqualTo(true);
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMinutes(11));
            assertThat(OtaHelper.isMtkOtaInProgress()).isTrue();
            assertThat(install.invoke(helper, firmware, context)).isEqualTo(false);
            verify(helper, times(1)).downloadMtkFirmware(anyString(), any(), any());
            verify(system, times(1)).installSystemOta(anyString());
            new MtkOtaReceiver().onReceive(context, new Intent(OtaConstants.ACTION_MTK_UPDATE_RESULT)
                    .putExtra("cmd", "success").putExtra("msg", "done"));
            assertThat(OtaHelper.isMtkOtaInProgress()).isFalse();
        }
    }

    @Test public void zeroPercentDownloadReportsRealBytesAndInstallDoesNotReuseThem() throws Exception {
        createHelper();
        OtaHelper.PhoneConnectionProvider phone = mock(OtaHelper.PhoneConnectionProvider.class);
        when(phone.isPhoneConnected()).thenReturn(true);
        helper.setPhoneConnectionProvider(phone);
        Method report = OtaHelper.class.getDeclaredMethod("sendProgressToPhone", String.class, int.class,
                long.class, long.class, String.class, String.class);
        report.setAccessible(true);
        report.invoke(helper, "download", 0, 0L, 640341205L, "STARTED", null);
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(3));
        report.invoke(helper, "download", 0, 8192L, 640341205L, "PROGRESS", null);
        report.invoke(helper, "install", 0, 0L, 0L, "STARTED", null);
        ArgumentCaptor<JSONObject> status = ArgumentCaptor.forClass(JSONObject.class);
        verify(phone, atLeast(3)).sendOtaStatus(status.capture());
        assertThat(status.getAllValues().stream().anyMatch(value -> value.optLong("bytes_downloaded") == 8192)).isTrue();
        assertThat(status.getValue().has("bytes_downloaded")).isFalse();
    }

    @Test public void activeSessionOwnsBytesAcrossQueriesStepsAndRetries() throws Exception {
        createHelper();
        helper.getSessionManager().createSession(new String[]{"apk", "mtk"}, "https://cdn/manifest.json");
        Method report = OtaHelper.class.getDeclaredMethod("sendProgressToPhone", String.class, int.class,
                long.class, long.class, String.class, String.class);
        report.setAccessible(true);
        report.invoke(helper, "download", 0, 8192L, 640341205L, "PROGRESS", null);
        JSONObject snapshot = helper.getSessionManager().getSessionState();
        assertThat(snapshot.getString("st")).isEqualTo("apk");
        assertThat(snapshot.getLong("bytes_downloaded")).isEqualTo(8192);
        Method phoneStatus = OtaHelper.class.getDeclaredMethod("buildOtaStatusForPhone");
        phoneStatus.setAccessible(true);
        assertThat(((JSONObject) phoneStatus.invoke(helper)).getLong("bytes_downloaded")).isEqualTo(8192);
        helper.getSessionManager().advanceStep(1, "download");
        assertThat(helper.getSessionManager().getSessionState().getLong("bytes_downloaded")).isZero();
        helper.getSessionManager().updateDownloadProgress(1, 99999);
        helper.getSessionManager().setFailed("test");
        helper.getSessionManager().createSession(new String[]{"mtk"}, "https://cdn/manifest.json");
        assertThat(helper.getSessionManager().getSessionState().getLong("bytes_downloaded")).isZero();
        helper.getSessionManager().advanceStep(0, "install");
        assertThat(helper.getSessionManager().getSessionState().has("bytes_downloaded")).isFalse();
    }

    @Test public void responseAndStreamBoundsFailBeforeOversizedWrites() throws Exception {
        OtaHelper.validateMtkResponse(600, -1, 1200);
        OtaHelper.validateMtkResponse(600, 600, 1200);
        assertThat(Assert.assertThrows(FirmwareDownloadException.class,
                () -> OtaHelper.validateMtkResponse(600, 700, 1200)).getErrorCode())
                .isEqualTo(FirmwareDownloadException.CODE_VERIFY_FAILED);
        assertThat(Assert.assertThrows(FirmwareDownloadException.class,
                () -> OtaHelper.validateMtkResponse(600, 600, 1199)).getErrorCode())
                .isEqualTo(AsgConstants.OTA_INSUFFICIENT_STORAGE);
        OtaHelper.validateMtkReceivedBytes(600, 600);
        assertThat(Assert.assertThrows(FirmwareDownloadException.class,
                () -> OtaHelper.validateMtkReceivedBytes(600, 601)).getErrorCode())
                .isEqualTo(FirmwareDownloadException.CODE_VERIFY_FAILED);
        assertThat(Assert.assertThrows(FirmwareDownloadException.class,
                () -> OtaHelper.validateMtkReceivedBytes(0, AsgConstants.MTK_OTA_MAX_DOWNLOAD_BYTES + 1)).getErrorCode())
                .isEqualTo(FirmwareDownloadException.CODE_FILE_TOO_LARGE);
    }
}
