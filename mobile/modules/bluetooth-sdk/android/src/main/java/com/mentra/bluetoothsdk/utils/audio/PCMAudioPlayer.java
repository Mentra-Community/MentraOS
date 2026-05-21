package com.mentra.core.utils.audio;

import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.os.Build;
import android.util.Log;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * PCM Audio Player for playing raw PCM audio data
 * Supports different sample rates, bit depths, and channel configurations
 */
public class PCMAudioPlayer {
    private static final String TAG = "PCMAudioPlayer";

    // Audio configuration
    private int sampleRate;
    private int channelConfig;
    private int audioFormat;
    private int bufferSize;

    // AudioTrack instance
    private AudioTrack audioTrack;
    private Context context;
    private AudioManager audioManager;

    // Playback state
    private AtomicBoolean isPlaying = new AtomicBoolean(false);
    private AtomicBoolean isInitialized = new AtomicBoolean(false);

    // Thread for playback
    private Thread playbackThread;

    /**
     * Constructor with default audio configuration
     */
    public PCMAudioPlayer(Context context) {
        this(context, 16000, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
    }

    /**
     * Constructor with custom audio configuration
     *
     * @param context Application context
     * @param sampleRate Sample rate in Hz (e.g., 16000, 44100, 48000)
     * @param channelConfig Channel configuration (MONO or STEREO)
     * @param audioFormat Audio format (16-bit, 8-bit, float, etc.)
     */
    public PCMAudioPlayer(Context context, int sampleRate, int channelConfig, int audioFormat) {
        this.context = context;
        this.audioManager = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        this.sampleRate = sampleRate;
        this.channelConfig = channelConfig;
        this.audioFormat = audioFormat;

        // Calculate buffer size
        this.bufferSize = AudioTrack.getMinBufferSize(sampleRate, channelConfig, audioFormat);
        if (this.bufferSize == AudioTrack.ERROR_BAD_VALUE) {
            Log.e(TAG, "Invalid audio configuration");
            return;
        }

        // Use a larger buffer for better performance
        this.bufferSize = Math.max(this.bufferSize * 2, 8192);

        initializeAudioTrack();
    }

    /**
     * Initialize the AudioTrack
     *
     * Uses USAGE_VOICE_COMMUNICATION and routes to Bluetooth SCO if available
     */
    private void initializeAudioTrack() {
        try {
            audioTrack = new AudioTrack.Builder()
                    .setAudioAttributes(new android.media.AudioAttributes.Builder()
                            .setUsage(android.media.AudioAttributes.USAGE_VOICE_COMMUNICATION)
                            .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH)
                            .build())
                    .setAudioFormat(new android.media.AudioFormat.Builder()
                            .setEncoding(audioFormat)
                            .setSampleRate(sampleRate)
                            .setChannelMask(channelConfig)
                            .build())
                    .setBufferSizeInBytes(bufferSize)
                    .setTransferMode(AudioTrack.MODE_STREAM)
                    .build();

            if (audioTrack.getState() == AudioTrack.STATE_INITIALIZED) {
                isInitialized.set(true);
                Log.d(TAG, "AudioTrack initialized successfully with USAGE_VOICE_COMMUNICATION");

                // Route to Bluetooth SCO if available
                routeToBluetoothIfAvailable();
            } else {
                Log.e(TAG, "Failed to initialize AudioTrack");
            }
        } catch (Exception e) {
            Log.e(TAG, "Error initializing AudioTrack", e);
        }
    }

    /**
     * Route audio to Bluetooth SCO device if available
     */
    private void routeToBluetoothIfAvailable() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M || audioManager == null || audioTrack == null) {
            return;
        }

        try {
            // Get all available audio output devices
            AudioDeviceInfo[] devices = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS);

            AudioDeviceInfo bluetoothDevice = null;

            // Look for Bluetooth SCO device
            for (AudioDeviceInfo device : devices) {
                if (device.getType() == AudioDeviceInfo.TYPE_BLUETOOTH_SCO) {
                    bluetoothDevice = device;
                    Log.d(TAG, "Found Bluetooth SCO device: " + device.getProductName());
                    break;
                }
            }

            // If we found a Bluetooth SCO device, route audio to it
            if (bluetoothDevice != null) {
                boolean success = audioTrack.setPreferredDevice(bluetoothDevice);
                if (success) {
                    Log.d(TAG, "Successfully routed audio to Bluetooth SCO device");
                } else {
                    Log.w(TAG, "Failed to route audio to Bluetooth SCO device");
                }
            } else {
                Log.d(TAG, "No Bluetooth SCO device available, using default routing");
            }
        } catch (Exception e) {
            Log.e(TAG, "Error routing to Bluetooth: " + e.getMessage());
        }
    }

    /**
     * Play PCM audio data
     *
     * @param pcmData Raw PCM audio data as byte array
     * @return true if playback started successfully
     */
    public boolean playPCMData(byte[] pcmData) {
        if (!isInitialized.get() || audioTrack == null) {
            Log.e(TAG, "AudioTrack not initialized");
            return false;
        }

        if (isPlaying.get()) {
            Log.w(TAG, "Already playing audio");
            return false;
        }

        isPlaying.set(true);

        playbackThread = new Thread(() -> {
            try {
                audioTrack.play();

                // Write the PCM data
                int written = audioTrack.write(pcmData, 0, pcmData.length);

                if (written < 0) {
                    Log.e(TAG, "Error writing audio data: " + written);
                } else {
                    Log.d(TAG, "Successfully wrote " + written + " bytes of audio data");
                }

                // Wait for playback to complete
                audioTrack.stop();

            } catch (Exception e) {
                Log.e(TAG, "Error during playback", e);
            } finally {
                isPlaying.set(false);
            }
        });

        playbackThread.start();
        return true;
    }

    /**
     * Play PCM audio data with streaming (for real-time audio)
     *
     * @param pcmData Raw PCM audio data as byte array
     * @return true if data was written successfully
     */
    public boolean streamPCMData(byte[] pcmData) {
        if (!isInitialized.get() || audioTrack == null) {
            Log.e(TAG, "AudioTrack not initialized");
            return false;
        }

        if (!isPlaying.get()) {
            // Start playback if not already playing
            audioTrack.play();
            isPlaying.set(true);
        }

        try {
            int written = audioTrack.write(pcmData, 0, pcmData.length);

            if (written < 0) {
                Log.e(TAG, "Error writing audio data: " + written);
                return false;
            }

            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error streaming audio data", e);
            return false;
        }
    }

    /**
     * Play PCM audio data from short array (16-bit samples)
     *
     * @param pcmData PCM audio data as short array
     * @return true if playback started successfully
     */
    public boolean playPCMData(short[] pcmData) {
        if (!isInitialized.get() || audioTrack == null) {
            Log.e(TAG, "AudioTrack not initialized");
            return false;
        }

        if (isPlaying.get()) {
            Log.w(TAG, "Already playing audio");
            return false;
        }

        isPlaying.set(true);

        playbackThread = new Thread(() -> {
            try {
                audioTrack.play();

                // Write the PCM data
                int written = audioTrack.write(pcmData, 0, pcmData.length);

                if (written < 0) {
                    Log.e(TAG, "Error writing audio data: " + written);
                } else {
                    Log.d(TAG, "Successfully wrote " + written + " samples of audio data");
                }

                // Wait for playback to complete
                audioTrack.stop();

            } catch (Exception e) {
                Log.e(TAG, "Error during playback", e);
            } finally {
                isPlaying.set(false);
            }
        });

        playbackThread.start();
        return true;
    }

    /**
     * Stream PCM audio data from short array (16-bit samples)
     *
     * @param pcmData PCM audio data as short array
     * @return true if data was written successfully
     */
    public boolean streamPCMData(short[] pcmData) {
        if (!isInitialized.get() || audioTrack == null) {
            Log.e(TAG, "AudioTrack not initialized");
            return false;
        }

        if (!isPlaying.get()) {
            // Start playback if not already playing
            audioTrack.play();
            isPlaying.set(true);
        }

        try {
            int written = audioTrack.write(pcmData, 0, pcmData.length);

            if (written < 0) {
                Log.e(TAG, "Error writing audio data: " + written);
                return false;
            }

            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error streaming audio data", e);
            return false;
        }
    }

    /**
     * Convert byte array to short array (for 16-bit PCM)
     *
     * @param byteData Raw PCM byte data
     * @return Short array representation
     */
    public static short[] bytesToShorts(byte[] byteData) {
        short[] shortData = new short[byteData.length / 2];
        ByteBuffer.wrap(byteData).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(shortData);
        return shortData;
    }

    /**
     * Convert short array to byte array (for 16-bit PCM)
     *
     * @param shortData PCM short data
     * @return Byte array representation
     */
    public static byte[] shortsToBytes(short[] shortData) {
        byte[] byteData = new byte[shortData.length * 2];
        ByteBuffer.wrap(byteData).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().put(shortData);
        return byteData;
    }

    /**
     * Stop playback
     */
    public void stop() {
        if (audioTrack != null && isPlaying.get()) {
            audioTrack.stop();
            isPlaying.set(false);
        }

        if (playbackThread != null && playbackThread.isAlive()) {
            playbackThread.interrupt();
        }
    }

    /**
     * Pause playback
     */
    public void pause() {
        if (audioTrack != null && isPlaying.get()) {
            audioTrack.pause();
        }
    }

    /**
     * Resume playback
     */
    public void resume() {
        if (audioTrack != null && isInitialized.get()) {
            audioTrack.play();
            isPlaying.set(true);
        }
    }

    /**
     * Set volume (0.0f to 1.0f)
     *
     * @param volume Volume level
     */
    public void setVolume(float volume) {
        if (audioTrack != null) {
            audioTrack.setVolume(volume);
        }
    }

    /**
     * Check if currently playing
     *
     * @return true if playing
     */
    public boolean isPlaying() {
        return isPlaying.get();
    }

    /**
     * Check if initialized
     *
     * @return true if initialized
     */
    public boolean isInitialized() {
        return isInitialized.get();
    }

    /**
     * Get current playback position in frames
     *
     * @return Playback position
     */
    public int getPlaybackHeadPosition() {
        if (audioTrack != null) {
            return audioTrack.getPlaybackHeadPosition();
        }
        return 0;
    }

    /**
     * Get audio session ID
     *
     * @return Audio session ID
     */
    public int getAudioSessionId() {
        if (audioTrack != null) {
            return audioTrack.getAudioSessionId();
        }
        return AudioManager.ERROR;
    }

    /**
     * Release resources
     */
    public void release() {
        stop();

        if (audioTrack != null) {
            audioTrack.release();
            audioTrack = null;
        }

        isInitialized.set(false);
        isPlaying.set(false);
    }
}
