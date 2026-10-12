package com.mentra.asg_client.io.ota.helpers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;
import android.content.Context;
import android.content.Intent;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaRegistry;
import com.mentra.asg_client.io.ota.services.OtaService;
import com.mentra.asg_client.io.ota.events.MtkOtaProgressEvent;
import com.mentra.asg_client.receiver.DebugMtkOtaReceiver;
import com.mentra.asg_client.AsgConstants;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.robolectric.Robolectric;
import static org.robolectric.Shadows.shadowOf;
import android.app.Application;
import org.robolectric.util.ReflectionHelpers;
import android.os.Looper;
import java.time.Duration;
import com.mentra.asg_client.service.system.core.SystemControllerFactory;
import com.mentra.asg_client.service.system.interfaces.ISystemController;
import org.mockito.MockedStatic;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class OtaHelperInlineMtkTest {
    private String manifest() throws Exception {
        JSONObject full = new JSONObject().put("end_firmware", "20260908.10").put("url", "https://cdn/full.zip").put("sha256", "a".repeat(64)).put("size", 1024);
        return new JSONObject().put("mtk_full_ota", full).toString();
    }

    @Test public void receiverOnlyDispatchesBoundedInputToItsForegroundService() throws Exception {
        Application application = ApplicationProvider.getApplicationContext();
        String frozen = manifest(), id = "firmware-" + "b".repeat(32);
        new DebugMtkOtaReceiver().onReceive(application, new Intent(DebugMtkOtaReceiver.ACTION_DEBUG_MTK_OTA)
                .putExtra(AsgConstants.DEBUG_MTK_OTA_MANIFEST_EXTRA, frozen)
                .putExtra(AsgConstants.DEBUG_MTK_OTA_ARTIFACT_ID_EXTRA, id));
        Intent worker = shadowOf(application).getNextStartedService();
        assertThat(worker.getComponent().getClassName()).isEqualTo(OtaService.class.getName());
        assertThat(worker.getStringExtra(AsgConstants.DEBUG_MTK_OTA_MANIFEST_EXTRA)).isEqualTo(frozen);
        assertThat(worker.getStringExtra(AsgConstants.DEBUG_MTK_OTA_ARTIFACT_ID_EXTRA)).isEqualTo(id);
        new DebugMtkOtaReceiver().onReceive(application, new Intent(DebugMtkOtaReceiver.ACTION_DEBUG_MTK_OTA)
                .putExtra(AsgConstants.DEBUG_MTK_OTA_MANIFEST_EXTRA, "x".repeat(AsgConstants.DEBUG_MTK_OTA_MANIFEST_MAX_BYTES + 1))
                .putExtra(AsgConstants.DEBUG_MTK_OTA_ARTIFACT_ID_EXTRA, id));
        assertThat(shadowOf(application).getNextStartedService()).isNull();
    }

    @Test public void inlineRequestUsesSharedDownloadAndRetainsItsOriginalSource() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences("ota_session", Context.MODE_PRIVATE).edit().clear().commit();
        OtaHelper original = new OtaHelper(context, mock(IBesOtaRegistry.class)), helper = spy(original);
        try {
            doReturn("20260709").when(helper).readMtkSourceVersion();
            doReturn("11111111-1111-4111-8111-111111111111").when(helper).readMtkSourceBoot();
            doReturn(false).when(helper).downloadMtkFirmware(anyString(), any(), any());
            String sha = "a".repeat(64), id = "firmware-" + "b".repeat(32);
            JSONObject full = new JSONObject().put("end_firmware", "20260908.10").put("url", "https://cdn/full.zip").put("sha256", sha).put("size", 1024);
            JSONObject patch = new JSONObject().put("start_firmware", "20260709").put("end_firmware", "20260908.10")
                    .put("url", "https://cdn/delta.zip").put("sha256", sha).put("size", 512);
            String manifest = new JSONObject().put("mtk_full_ota", full).put("mtk_patches", new JSONArray().put(patch)).toString();
            assertThat(helper.startValidatedDebugMtkFirmware(manifest, id)).isTrue();
            verify(helper, times(1)).downloadMtkFirmware(eq("https://cdn/delta.zip"), any(), eq(context));
            assertThat(helper.getSessionManager().getMtkRestoreReceipt().getString("source_version")).isEqualTo("20260709");
            assertThat(helper.getSessionManager().getMtkRestoreReceipt().getString("artifact_id")).isEqualTo(id);
            assertThat(helper.getSessionManager().getStatus()).isEqualTo("failed");
            assertThat(helper.startValidatedDebugMtkFirmware(manifest, id)).isFalse();
            verify(helper, times(1)).downloadMtkFirmware(anyString(), any(), any());
        } finally {helper.cleanup(); original.cleanup(); OtaHelper.setMtkOtaInProgress(false); OtaHelper.clearMtkSessionFlag();}
    }

    @Test public void foregroundServiceReturnsWhileItsAdmittedDownloadIsBlocked() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences("ota_session", Context.MODE_PRIVATE).edit().clear().commit();
        OtaHelper original = new OtaHelper(context, mock(IBesOtaRegistry.class)), helper = spy(original);
        CountDownLatch downloading = new CountDownLatch(1), release = new CountDownLatch(1), finished = new CountDownLatch(1);
        try {
            doReturn("20260709").when(helper).readMtkSourceVersion();
            doReturn("11111111-1111-4111-8111-111111111111").when(helper).readMtkSourceBoot();
            doAnswer(call -> {downloading.countDown(); release.await(5, TimeUnit.SECONDS); return false;})
                    .when(helper).downloadMtkFirmware(anyString(), any(), any());
            doAnswer(call -> {try {return call.callRealMethod();} finally {finished.countDown();}})
                    .when(helper).startValidatedDebugMtkFirmware(anyString(), anyString());
            OtaService service = Robolectric.buildService(OtaService.class).get();
            ReflectionHelpers.setField(service, "otaHelper", helper);
            service.onStartCommand(new Intent(context, OtaService.class).setAction(DebugMtkOtaReceiver.ACTION_DEBUG_MTK_OTA)
                    .putExtra(AsgConstants.DEBUG_MTK_OTA_MANIFEST_EXTRA, manifest())
                    .putExtra(AsgConstants.DEBUG_MTK_OTA_ARTIFACT_ID_EXTRA, "firmware-" + "b".repeat(32)), 0, 1);
            assertThat(downloading.await(5, TimeUnit.SECONDS)).isTrue();
            assertThat(finished.getCount()).isEqualTo(1);
            helper.reconcileInlineMtkAfterRestart(); // Same-process service recreation must not fail its live worker.
            assertThat(helper.getSessionManager().getStatus()).isEqualTo("in_progress");
        } finally {
            release.countDown();
            assertThat(finished.await(5, TimeUnit.SECONDS)).isTrue();
            helper.cleanup(); original.cleanup(); OtaHelper.setMtkOtaInProgress(false); OtaHelper.clearMtkSessionFlag();
        }
    }

    @Test public void recreatedHelperRefusesUrlWorkBeforeAnyArtifactDownload() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences("ota_session", Context.MODE_PRIVATE).edit().clear().commit();
        OtaHelper original = new OtaHelper(context, mock(IBesOtaRegistry.class));
        original.getSessionManager().createMtkRestore("firmware-" + "b".repeat(32), "a".repeat(64),
                new JSONObject(manifest()).getJSONObject("mtk_full_ota"), "20260709", "original-boot");
        OtaHelper replacement = spy(new OtaHelper(context, mock(IBesOtaRegistry.class)));
        try {
            assertThat(replacement.startVersionCheckWithUrl(context, "https://cdn/different.json")).isFalse();
            verify(replacement, never()).downloadMtkFirmware(anyString(), any(), any());
            assertThat(replacement.getSessionManager().getMtkRestoreReceipt().getString("url")).isEqualTo("https://cdn/full.zip");
            java.lang.reflect.Method install = OtaHelper.class.getDeclaredMethod("checkAndUpdateMtkFirmware", JSONObject.class, Context.class);
            install.setAccessible(true);
            JSONObject different = new JSONObject(manifest()).getJSONObject("mtk_full_ota").put("url", "https://cdn/different.zip");
            assertThat(install.invoke(replacement, different, context)).isEqualTo(false);
            verify(replacement, never()).downloadMtkFirmware(anyString(), any(), any());
        } finally {replacement.getSessionManager().clear(); replacement.cleanup(); original.cleanup();}
    }

    @Test public void recreatedServiceRetainsNativeInstallAndItsOriginalRebootPolicy() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences("ota_session", Context.MODE_PRIVATE).edit().clear().commit();
        OtaHelper original = new OtaHelper(context, mock(IBesOtaRegistry.class));
        original.getSessionManager().createMtkRestore("firmware-" + "b".repeat(32), "a".repeat(64),
                new JSONObject(manifest()).getJSONObject("mtk_full_ota"), "20260709", "11111111-1111-4111-8111-111111111111");
        original.getSessionManager().markMtkInstallDispatched();
        OtaHelper replacement = spy(new OtaHelper(context, mock(IBesOtaRegistry.class)));
        try {
            doReturn("20260709").when(replacement).readMtkSourceVersion();
            doReturn("11111111-1111-4111-8111-111111111111").when(replacement).readMtkSourceBoot();
            replacement.reconcileInlineMtkAfterRestart();
            assertThat(OtaHelper.isMtkOtaInProgress()).isTrue();
            assertThat(replacement.startVersionCheckWithUrl(context, "https://cdn/different.json")).isFalse();
            assertThat(replacement.consumeRebootAfterMtkInstall()).isTrue();
            assertThat(replacement.consumeRebootAfterMtkInstall()).isFalse();
            verify(replacement, never()).downloadMtkFirmware(anyString(), any(), any());
        } finally {replacement.getSessionManager().clear(); replacement.cleanup(); original.cleanup(); OtaHelper.setMtkOtaInProgress(false);}
    }

    @Test public void nativeSuccessRetainsCustodyUntilTheSelectedFirmwareActuallyBoots() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences("ota_session", Context.MODE_PRIVATE).edit().clear().commit();
        OtaHelper helper = new OtaHelper(context, mock(IBesOtaRegistry.class));
        try {
            for (boolean targetBoot : new boolean[]{true, false}) {
                helper.getSessionManager().clear();
                helper.getSessionManager().createMtkRestore("firmware-" + (targetBoot ? "b" : "c").repeat(32), "a".repeat(64),
                        new JSONObject(manifest()).getJSONObject("mtk_full_ota"), "20260709", "original-boot");
                helper.getSessionManager().markMtkInstallDispatched();
                ReflectionHelpers.setField(helper, "rebootAfterMtkInstall", true);
                OtaService service = Robolectric.buildService(OtaService.class).get();
                ReflectionHelpers.setField(service, "otaHelper", helper);
                service.onMtkOtaProgress(MtkOtaProgressEvent.createSuccess("done"));
                assertThat(helper.getSessionManager().getStatus()).isEqualTo("in_progress");
                assertThat(helper.getSessionManager().getCurrentPhase()).isEqualTo("awaiting_reboot");
                assertThat(helper.startVersionCheckWithUrl(context, "https://cdn/other.json")).isFalse();
                com.mentra.asg_client.io.ota.session.OtaSessionManager restarted = new com.mentra.asg_client.io.ota.session.OtaSessionManager(context);
                restarted.reconcileMtkRestore("20260709", "original-boot");
                assertThat(restarted.hasActiveMtkRestore()).isTrue();
                restarted.reconcileMtkRestore(targetBoot ? "MentraLive_20260908.10" : "20260709", "new-boot");
                assertThat(restarted.getStatus()).isEqualTo(targetBoot ? "complete" : "failed");
            }
        } finally {helper.getSessionManager().clear(); helper.cleanup(); OtaHelper.setMtkOtaInProgress(false);}
    }

    @Test public void serviceRestartRecoversOnlyTheRecordedPendingReboot() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences("ota_session", Context.MODE_PRIVATE).edit().clear().commit();
        OtaHelper original = new OtaHelper(context, mock(IBesOtaRegistry.class));
        original.getSessionManager().createMtkRestore("firmware-" + "b".repeat(32), "a".repeat(64),
                new JSONObject(manifest()).getJSONObject("mtk_full_ota"), "20260709", "11111111-1111-4111-8111-111111111111");
        original.getSessionManager().markMtkInstallDispatched();
        original.getSessionManager().stageMtkRestoreForReboot();
        OtaHelper replacement = spy(new OtaHelper(context, mock(IBesOtaRegistry.class)));
        ISystemController system = mock(ISystemController.class);
        try (MockedStatic<SystemControllerFactory> factory = mockStatic(SystemControllerFactory.class)) {
            factory.when(() -> SystemControllerFactory.get(any())).thenReturn(system);
            doReturn("20260709").when(replacement).readMtkSourceVersion();
            doReturn("11111111-1111-4111-8111-111111111111").when(replacement).readMtkSourceBoot();
            OtaService service = Robolectric.buildService(OtaService.class).get();
            ReflectionHelpers.setField(service, "otaHelper", replacement);
            ReflectionHelpers.callInstanceMethod(service, "recoverInlineMtkAfterRestart");
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(3));
            verify(system, times(1)).reboot();
            verify(system, never()).installSystemOta(anyString());
            assertThat(replacement.getSessionManager().hasActiveMtkRestore()).isTrue();
            assertThat(replacement.startVersionCheckWithUrl(context, "https://cdn/other.json")).isFalse();

            OtaHelper.setMtkOtaInProgress(false);
            replacement.getSessionManager().clear();
            replacement.getSessionManager().createMtkRestore("firmware-" + "c".repeat(32), "a".repeat(64),
                    new JSONObject(manifest()).getJSONObject("mtk_full_ota"), "20260709", "11111111-1111-4111-8111-111111111111");
            replacement.getSessionManager().markMtkInstallDispatched();
            OtaService uncertain = Robolectric.buildService(OtaService.class).get();
            ReflectionHelpers.setField(uncertain, "otaHelper", replacement);
            ReflectionHelpers.callInstanceMethod(uncertain, "recoverInlineMtkAfterRestart");
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(3));
            verify(system, times(1)).reboot();
        } finally {replacement.getSessionManager().clear(); replacement.cleanup(); original.cleanup(); OtaHelper.setMtkOtaInProgress(false);}
    }
}
