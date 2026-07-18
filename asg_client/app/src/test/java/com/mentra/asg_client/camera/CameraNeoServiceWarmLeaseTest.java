package com.mentra.asg_client.camera;

import static org.assertj.core.api.Assertions.assertThat;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** Verifies compatible ready leases retain the mode required by the warm reuse guard. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class CameraNeoServiceWarmLeaseTest {

    @Test
    public void firstReadyLeaseEstablishesNormalizedWarmMode() throws Exception {
        CameraNeoService service = new CameraNeoService();
        Method addWarmLease =
                CameraNeoService.class.getDeclaredMethod(
                        "addWarmLease",
                        CameraNeoService.CameraWarmUpCallback.class,
                        long.class,
                        String.class);
        addWarmLease.setAccessible(true);

        addWarmLease.invoke(service, callback("warm-1"), 30_000L, "text");
        addWarmLease.invoke(service, callback("warm-2"), 30_000L, "text");

        Field warmLeaseMode = CameraNeoService.class.getDeclaredField("warmLeaseMode");
        warmLeaseMode.setAccessible(true);
        assertThat(warmLeaseMode.get(service)).isEqualTo("text");

        Field warmLeases = CameraNeoService.class.getDeclaredField("warmLeases");
        warmLeases.setAccessible(true);
        assertThat((Map<?, ?>) warmLeases.get(service)).hasSize(2);
    }

    @Test
    public void readyLeaseIsMarkedBeforeReadyCallbackRuns() throws Exception {
        CameraNeoService service = new CameraNeoService();
        Field readyRequestIds = CameraNeoService.class.getDeclaredField("warmReadyRequestIds");
        readyRequestIds.setAccessible(true);
        @SuppressWarnings("unchecked")
        Set<String> readyIds = (Set<String>) readyRequestIds.get(service);
        AtomicBoolean callbackObservedReady = new AtomicBoolean(false);
        CameraNeoService.CameraWarmUpCallback callback =
                callback(
                        "warm-ready",
                        () -> callbackObservedReady.set(readyIds.contains("warm-ready")));

        Method addWarmLease =
                CameraNeoService.class.getDeclaredMethod(
                        "addWarmLease",
                        CameraNeoService.CameraWarmUpCallback.class,
                        long.class,
                        String.class);
        addWarmLease.setAccessible(true);
        addWarmLease.invoke(service, callback, 30_000L, "photo");

        Method deliverWarmReady =
                CameraNeoService.class.getDeclaredMethod(
                        "deliverWarmReady", CameraNeoService.CameraWarmUpCallback.class);
        deliverWarmReady.setAccessible(true);
        deliverWarmReady.invoke(service, callback);

        assertThat(callbackObservedReady).isTrue();
    }

    private static CameraNeoService.CameraWarmUpCallback callback(String requestId) {
        return callback(requestId, () -> {});
    }

    private static CameraNeoService.CameraWarmUpCallback callback(
            String requestId, Runnable onReady) {
        return new CameraNeoService.CameraWarmUpCallback() {
            @Override
            public void onWarming() {}

            @Override
            public void onCameraReady() {
                onReady.run();
            }

            @Override
            public void onCameraStopped() {}

            @Override
            public void onCameraError(String errorMessage) {}

            @Override
            public String getRequestId() {
                return requestId;
            }
        };
    }
}
