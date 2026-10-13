package com.mentra.asg_client.io.ota.helpers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.*;

import android.content.Context;
import android.os.Bundle;

import androidx.test.core.app.ApplicationProvider;

import com.mentra.asg_client.RecoveryWorkerManager;
import com.mentra.asg_client.io.network.interfaces.INetworkManager;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaRegistry;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.MockedStatic;
import org.robolectric.RobolectricTestRunner;

import java.lang.reflect.Method;

@RunWith(RobolectricTestRunner.class)
public class OtaDowngradeNetworkCleanupTest {
    private OtaHelper helper;
    private INetworkManager network;

    @Before
    public void setUp() {
        Context context = ApplicationProvider.getApplicationContext();
        helper = new OtaHelper(context, mock(IBesOtaRegistry.class));
        network = mock(INetworkManager.class);
        helper.setNetworkManager(network);
    }

    @After
    public void tearDown() {
        helper.cleanup();
    }

    @Test
    public void handsOffOnlyAfterTheExistingOwnerVerifiesNativeStop() throws Exception {
        assertThat(helper.prepareNetworkForDowngrade()).isTrue();
        verify(network).stopHotspotAndAwaitDisabled();
        verifyNoMoreInteractions(network);
    }

    @Test
    public void nativeStopFailureRefusesHandoffInsteadOfKillingTheOwner() throws Exception {
        doThrow(new java.io.IOException("AP remained registered"))
                .when(network)
                .stopHotspotAndAwaitDisabled();
        assertThat(helper.prepareNetworkForDowngrade()).isFalse();
        verify(network).stopHotspotAndAwaitDisabled();
        verify(network).abandonHotspotReplacement();
    }

    @Test
    public void missingServiceOwnerRefusesTheDestructiveHandoff() {
        helper.setNetworkManager(null);
        assertThat(helper.prepareNetworkForDowngrade()).isFalse();
        verifyNoInteractions(network);
    }

    @Test
    public void failedPreHandoffCommitReleasesHotspotAdmission() throws Exception {
        OtaHelper original = helper;
        helper = spy(helper);
        original.cleanup();
        helper.setNetworkManager(network);
        doReturn(true).when(helper).downloadApk(anyString(), any(), any(), anyString());
        doReturn(false).when(helper).persistPendingDowngrade();
        JSONObject apk = new JSONObject();
        apk.put("versionCode", 302010070L);
        apk.put("sha256", "verified-sha");
        apk.put("apkUrl", "https://example.com/baseline.apk");
        Context context = ApplicationProvider.getApplicationContext();
        try (MockedStatic<RecoveryWorkerManager> recovery =
                mockStatic(RecoveryWorkerManager.class)) {
            recovery.when(() -> RecoveryWorkerManager.awaitDowngradeReady(context))
                    .thenReturn(new RecoveryWorkerManager.DowngradeStatus(new Bundle()));
            Method handoff =
                    OtaHelper.class.getDeclaredMethod(
                            "stageAndHandoffDowngrade", JSONObject.class, Context.class);
            handoff.setAccessible(true);
            assertThat((Boolean) handoff.invoke(helper, apk, context)).isFalse();
        }
        var order = inOrder(network, helper);
        order.verify(network).stopHotspotAndAwaitDisabled();
        order.verify(helper).persistPendingDowngrade();
        order.verify(network).abandonHotspotReplacement();
    }
}
