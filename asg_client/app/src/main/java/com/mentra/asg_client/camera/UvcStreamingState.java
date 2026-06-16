package com.mentra.asg_client.camera;

/**
 * Tracks USB UVC (webcam) streaming state from MTK firmware broadcasts.
 *
 * @see com.mentra.asg_client.receiver.UvcStreamingBroadcastReceiver
 */
public final class UvcStreamingState {

    public static final String ACTION_UVC_STREAMING_CHANGED =
            "com.uvc.action.UVC_STREAMING_CHANGED";
    public static final String EXTRA_STREAMING = "streaming";

    private static volatile boolean sStreaming;

    private UvcStreamingState() {}

    public static void setStreaming(boolean streaming) {
        sStreaming = streaming;
    }

    public static boolean isStreaming() {
        return sStreaming;
    }
}
