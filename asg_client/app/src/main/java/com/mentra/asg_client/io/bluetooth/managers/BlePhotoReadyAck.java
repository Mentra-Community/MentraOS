package com.mentra.asg_client.io.bluetooth.managers;

import android.util.Log;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Synchronizes ASG {@code ble_photo_ready} transmission with phone {@code ble_ready_ack} so file
 * packets start only after the JSON notification has reached the phone (Phase 2).
 */
public final class BlePhotoReadyAck {

    private static final String TAG = "BlePhotoReadyAck";
    private static final ConcurrentHashMap<String, CountDownLatch> LATCHES =
            new ConcurrentHashMap<>();

    private BlePhotoReadyAck() {}

    public static void prepare(String requestId) {
        if (requestId == null || requestId.isEmpty()) {
            return;
        }
        LATCHES.put(requestId, new CountDownLatch(1));
    }

    public static boolean await(String requestId, long timeoutMs) {
        if (requestId == null || requestId.isEmpty()) {
            return false;
        }
        CountDownLatch latch = LATCHES.get(requestId);
        if (latch == null) {
            return false;
        }
        try {
            boolean signaled = latch.await(timeoutMs, TimeUnit.MILLISECONDS);
            if (!signaled) {
                Log.w(TAG, "ble_ready_ack timeout for requestId=" + requestId);
            }
            return signaled;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            Log.w(TAG, "ble_ready_ack wait interrupted for requestId=" + requestId);
            return false;
        } finally {
            LATCHES.remove(requestId);
        }
    }

    public static void signal(String requestId) {
        if (requestId == null || requestId.isEmpty()) {
            return;
        }
        CountDownLatch latch = LATCHES.remove(requestId);
        if (latch != null) {
            latch.countDown();
            Log.i(TAG, "ble_ready_ack received for requestId=" + requestId);
        }
    }
}
