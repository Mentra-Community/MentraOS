package com.mentra.asg_client.audio;

/**
 * Constants for audio asset file names in the application's assets directory. Most audio files are
 * in WAV format for optimal compatibility with I2S audio routing. Some files (like battery
 * announcements and storage alerts) use MP3 format.
 *
 * <p>Usage:
 *
 * <pre>
 * if (hardwareManager.supportsAudioPlayback()) {
 *     hardwareManager.playAudioAsset(AudioAssets.CAMERA_SNAP);
 * }
 * </pre>
 */
public final class AudioAssets {

    // Prevent instantiation
    private AudioAssets() {
        throw new AssertionError("AudioAssets is a utility class and should not be instantiated");
    }

    /** Low battery notification sound */
    public static final String BATTERY_LOW = "battery_low.wav";

    /** Storage full notification sound */
    public static final String STORAGE_FULL = "storage_full.mp3";

    /** Short hold-still cue repeated while a cold capture spins up the camera and ISP. */
    public static final String CAMERA_PREP_CLICK = "camera_prep_click.wav";

    /** Camera snap anchored to sensor exposure timing or the completed JPEG frame boundary. */
    public static final String CAMERA_SNAP = "camera_snap.wav";

    /** UI click or button press sound */
    public static final String CLICK_SOUND = "click_sound.wav";

    /** Device/glasses connected notification */
    public static final String CONNECTED = "connected.wav";

    /** Device/glasses disconnected notification */
    public static final String DISCONNECTED = "disconnected.wav";

    /** Power off sound */
    public static final String POWER_OFF = "power_off.wav";

    /** Power on sound */
    public static final String POWER_ON = "power_on.wav";

    /** Audio recording started notification */
    public static final String RECORDING_START = "recording_start.wav";

    /** Audio recording stopped notification */
    public static final String RECORDING_STOP = "recording_stop.wav";

    /** Volume adjustment sound */
    public static final String VOLUME_CHANGE = "volume_change.wav";

    /** Video recording started notification Same as audio recording start for consistency */
    public static final String VIDEO_RECORDING_START = RECORDING_START;

    /** Video recording stopped notification Same as audio recording stop for consistency */
    public static final String VIDEO_RECORDING_STOP = RECORDING_STOP;

    /** Spoken pairing-code clip folder ({@code letter_a.wav}, {@code digit_0.wav}, ...). */
    public static final String PAIRING_PREFIX = "pairing/";

    /** “Connect to your Mentra Live in the app. Your code is:” */
    public static final String PAIRING_INTRO = PAIRING_PREFIX + "pairing_intro.wav";

    /** Spoken confirmation after the glasses leave pairing mode. */
    public static final String PAIRING_EXITED = PAIRING_PREFIX + "pairing_exited.wav";

    /** Battery level announcement audio folder prefix */
    public static final String BATTERY_LEVEL_PREFIX = "battery/";

    /**
     * Get battery level announcement audio file path. Rounds to nearest 10% (10, 20, 30... 100).
     *
     * @param percent Battery level 0-100
     * @return Asset path like "battery/50.mp3"
     */
    public static String getBatteryLevelAsset(int percent) {
        int rounded = Math.max(10, Math.min(100, ((percent + 5) / 10) * 10));
        return BATTERY_LEVEL_PREFIX + rounded + ".mp3";
    }

    /**
     * Map a pairing-code character to its spoken clip.
     *
     * @param c alphanumeric character; letters are case-insensitive
     * @return asset path like {@code pairing/letter_a.wav}, or {@code null} if unsupported
     */
    public static String getPairingCharAsset(char c) {
        if (c >= '0' && c <= '9') {
            return PAIRING_PREFIX + "digit_" + c + ".wav";
        }
        char lower = Character.toLowerCase(c);
        if (lower >= 'a' && lower <= 'z') {
            return PAIRING_PREFIX + "letter_" + lower + ".wav";
        }
        return null;
    }
}
