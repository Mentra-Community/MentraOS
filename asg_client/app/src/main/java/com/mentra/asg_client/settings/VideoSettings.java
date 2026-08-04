package com.mentra.asg_client.settings;

/**
 * Video recording settings configuration Handles resolution and fps settings for video recording
 */
public class VideoSettings {
    private static final String TAG = "VideoSettings";

    public final int width;
    public final int height;
    public final int fps;

    public VideoSettings(int width, int height, int fps) {
        this.width = width;
        this.height = height;
        this.fps = fps;
    }

    /** Create default settings (1080p at 30fps) */
    public static VideoSettings getDefault() {
        return new VideoSettings(1920, 1080, 30);
    }

    /** Create 1080p settings */
    public static VideoSettings get1080p() {
        return new VideoSettings(1920, 1080, 30);
    }

    /** Create 720p settings */
    public static VideoSettings get720p() {
        return new VideoSettings(1280, 720, 30);
    }

    /**
     * Validate if resolution is supported.
     *
     * <p>Only resolutions the Mentra Live sensor can actually record are advertised here. 1440p
     * (2560x1920) and 4K (3840x2160) were previously listed but the sensor cannot encode them —
     * requesting one fails to record AND wedges the camera in a stuck recording until the app
     * restarts. They are intentionally excluded; {@link
     * com.mentra.asg_client.camera.lifecycle.CameraOpener} additionally validates the request
     * against the sensor's real getOutputSizes() at capture time as a second line of defense.
     */
    public static boolean isSupported(int width, int height) {
        return (width == 1920 && height == 1080) || (width == 1280 && height == 720);
    }

    /** Validate these settings */
    public boolean isValid() {
        return isSupported(width, height) && fps > 0 && fps <= 60;
    }

    @Override
    public String toString() {
        return String.format("%dx%d@%dfps", width, height, fps);
    }

    @Override
    public boolean equals(Object obj) {
        if (this == obj) return true;
        if (obj == null || getClass() != obj.getClass()) return false;
        VideoSettings other = (VideoSettings) obj;
        return width == other.width && height == other.height && fps == other.fps;
    }

    @Override
    public int hashCode() {
        int result = width;
        result = 31 * result + height;
        result = 31 * result + fps;
        return result;
    }
}
