package com.mentra.asg_client.camera;

/**
 * Immutable photo work item for {@link PhotoRequestQueue}, except {@link #callback}
 * which may be filled from the registry when the request was enqueued without a callback reference.
 */
public final class PhotoRequest {
    public final String requestId;
    public final String filePath;
    public final String size;
    public final boolean enableLed;
    public final boolean isFromSdk;
    /** Per-request only; null = auto exposure. */
    public final Long exposureTimeNs;
    public final long timestamp;
    public CameraNeo.PhotoCaptureCallback callback;

    public PhotoRequest(
            String filePath,
            String size,
            boolean enableLed,
            boolean isFromSdk,
            Long exposureTimeNs,
            CameraNeo.PhotoCaptureCallback callback) {
        this.requestId = "photo_" + System.currentTimeMillis() + "_" + filePath.hashCode();
        this.filePath = filePath;
        this.size = size;
        this.enableLed = enableLed;
        this.isFromSdk = isFromSdk;
        this.exposureTimeNs = exposureTimeNs;
        this.callback = callback;
        this.timestamp = System.currentTimeMillis();
    }
}
