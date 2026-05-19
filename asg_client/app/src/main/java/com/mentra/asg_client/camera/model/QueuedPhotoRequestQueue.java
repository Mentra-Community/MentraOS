package com.mentra.asg_client.camera.model;

import android.util.Log;

import com.mentra.asg_client.camera.CameraNeoService;

import java.util.HashMap;
import java.util.LinkedList;
import java.util.Map;
import java.util.Queue;

/**
 * Process-wide FIFO of {@link QueuedPhotoRequest} items plus a callback registry keyed by
 * {@link QueuedPhotoRequest#requestId}.
 *
 * <p><b>Why global?</b> Photo commands can arrive from BLE, button, and SDK while
 * {@link com.mentra.asg_client.camera.CameraNeoService} restarts; the queue survives instance churn
 * so rapid bursts are serialized instead of dropped.
 *
 * <p><b>Callback registry:</b> If a request is offered with a non-null callback, it is stored under
 * {@code requestId}. If offered with {@code null} (e.g. caller only had an id), {@link #poll()} and
 * {@link #attachRegistryCallback(QueuedPhotoRequest)} restore the callback before dispatch.
 *
 * <p><b>Thread safety:</b> All public methods are {@code synchronized} on this singleton.
 *
 * @see ActivePhotoCapture for the in-flight snapshot after dequeue
 */
public final class QueuedPhotoRequestQueue {
    private static final String TAG = "QueuedPhotoRequestQueue";
    private static final QueuedPhotoRequestQueue INSTANCE = new QueuedPhotoRequestQueue();

    private final Queue<QueuedPhotoRequest> queue = new LinkedList<>();
    private final Map<String, CameraNeoService.PhotoCaptureCallback> callbackRegistry = new HashMap<>();

    private QueuedPhotoRequestQueue() {}

    public static QueuedPhotoRequestQueue getInstance() {
        return INSTANCE;
    }

    public synchronized void offer(QueuedPhotoRequest request) {
        queue.offer(request);
        if (request.callback != null) {
            callbackRegistry.put(request.requestId, request.callback);
        }
    }

    public synchronized boolean isEmpty() {
        return queue.isEmpty();
    }

    public synchronized int size() {
        return queue.size();
    }

    public synchronized QueuedPhotoRequest peek() {
        return queue.peek();
    }

    /**
     * Ensures the head (or a peeked) request has its callback before comparing camera config or
     * opening the HAL. Does not remove from the queue.
     */
    public synchronized void attachRegistryCallback(QueuedPhotoRequest queued) {
        if (queued == null) {
            return;
        }
        if (queued.callback == null && callbackRegistry.containsKey(queued.requestId)) {
            queued.callback = callbackRegistry.get(queued.requestId);
        }
    }

    /**
     * Removes and returns the head request, binding {@link QueuedPhotoRequest#callback} from the
     * registry when needed.
     */
    public synchronized QueuedPhotoRequest poll() {
        QueuedPhotoRequest queued = queue.poll();
        bindCallbackIfNeeded(queued);
        return queued;
    }

    private void bindCallbackIfNeeded(QueuedPhotoRequest queued) {
        if (queued == null) {
            return;
        }
        if (queued.callback == null && callbackRegistry.containsKey(queued.requestId)) {
            queued.callback = callbackRegistry.remove(queued.requestId);
        } else {
            callbackRegistry.remove(queued.requestId);
        }
    }

    /**
     * Fail every queued request and clear the registry (e.g. camera service destroyed).
     */
    public synchronized void failAllPending(String errorMessage) {
        QueuedPhotoRequest queued;
        while ((queued = queue.poll()) != null) {
            CameraNeoService.PhotoCaptureCallback cb = queued.callback;
            if (cb == null) {
                cb = callbackRegistry.remove(queued.requestId);
            } else {
                callbackRegistry.remove(queued.requestId);
            }
            if (cb != null) {
                Log.w(TAG, "Failing pending request: " + queued.requestId);
                try {
                    cb.onPhotoError(errorMessage);
                } catch (Exception e) {
                    // Guard so one bad listener can't strand the rest of the queue.
                    Log.e(TAG, "Pending-failure callback threw for " + queued.requestId, e);
                }
            }
        }
        for (CameraNeoService.PhotoCaptureCallback orphan : callbackRegistry.values()) {
            if (orphan != null) {
                try {
                    orphan.onPhotoError(errorMessage);
                } catch (Exception e) {
                    Log.e(TAG, "Orphan-registry callback threw", e);
                }
            }
        }
        callbackRegistry.clear();
    }
}
