package com.mentra.asg_client.camera.model;

import android.util.Log;

import com.mentra.asg_client.camera.CameraNeoService;

import java.util.HashMap;
import java.util.LinkedList;
import java.util.Map;
import java.util.Queue;

/**
 * Global FIFO queue and callback registry for photo requests (survives service instance churn).
 */
public final class PhotoRequestQueue {
    private static final String TAG = "PhotoRequestQueue";
    private static final PhotoRequestQueue INSTANCE = new PhotoRequestQueue();

    private final Queue<PhotoRequest> queue = new LinkedList<>();
    private final Map<String, CameraNeoService.PhotoCaptureCallback> callbackRegistry = new HashMap<>();

    private PhotoRequestQueue() {}

    public static PhotoRequestQueue getInstance() {
        return INSTANCE;
    }

    public synchronized void offer(PhotoRequest request) {
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

    public synchronized PhotoRequest peek() {
        return queue.peek();
    }

    public synchronized void attachRegistryCallback(PhotoRequest pr) {
        if (pr == null) {
            return;
        }
        if (pr.callback == null && callbackRegistry.containsKey(pr.requestId)) {
            pr.callback = callbackRegistry.get(pr.requestId);
        }
    }

    /**
     * Removes and returns the head request, binding {@link PhotoRequest#callback} from the registry when needed.
     */
    public synchronized PhotoRequest poll() {
        PhotoRequest pr = queue.poll();
        bindCallbackIfNeeded(pr);
        return pr;
    }

    private void bindCallbackIfNeeded(PhotoRequest pr) {
        if (pr == null) {
            return;
        }
        if (pr.callback == null && callbackRegistry.containsKey(pr.requestId)) {
            pr.callback = callbackRegistry.remove(pr.requestId);
        } else {
            callbackRegistry.remove(pr.requestId);
        }
    }

    /**
     * Fail every queued request and clear the registry (e.g. service destroyed).
     */
    public synchronized void failAllPending(String errorMessage) {
        PhotoRequest pr;
        while ((pr = queue.poll()) != null) {
            CameraNeoService.PhotoCaptureCallback cb = pr.callback;
            if (cb == null) {
                cb = callbackRegistry.remove(pr.requestId);
            } else {
                callbackRegistry.remove(pr.requestId);
            }
            if (cb != null) {
                Log.w(TAG, "Failing pending request: " + pr.requestId);
                cb.onPhotoError(errorMessage);
            }
        }
        for (CameraNeoService.PhotoCaptureCallback orphan : callbackRegistry.values()) {
            if (orphan != null) {
                orphan.onPhotoError(errorMessage);
            }
        }
        callbackRegistry.clear();
    }
}
