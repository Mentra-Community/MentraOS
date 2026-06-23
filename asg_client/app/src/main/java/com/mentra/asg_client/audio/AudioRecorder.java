package com.mentra.asg_client.audio;

import android.content.Context;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;

import androidx.annotation.Nullable;

import com.mentra.asg_client.io.media.interfaces.AudioChunkCallback;

import java.nio.ByteBuffer;

/**
 * Captures raw PCM audio from the device microphone and delivers chunks to a registered callback.
 *
 * <h3>Audio source selection</h3>
 * Uses {@link MediaRecorder.AudioSource#UNPROCESSED} when the device advertises support via
 * {@link AudioManager#PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED}, bypassing vendor DSP
 * processing (beamforming, noise suppression, AGC, echo cancellation) that would otherwise
 * be applied upstream before samples reach this app. Falls back to
 * {@link MediaRecorder.AudioSource#MIC} on devices that do not support the unprocessed path.
 *
 * <h3>Configuration</h3>
 * Records at 16 kHz, 16-bit mono PCM — the standard for speech processing and on-device ASR.
 * The internal read buffer is sized at 2× the platform minimum to reduce the risk of overruns
 * on low-end hardware while keeping latency manageable.
 *
 * <h3>Threading</h3>
 * All {@link AudioRecord} reads run on a dedicated {@link HandlerThread} ({@code "AudioRecorder"}).
 * {@link #start} and {@link #stop} are safe to call from any thread. The {@link AudioChunkCallback}
 * is invoked on the recorder thread, so callers should not block there for long.
 *
 * <h3>Lifecycle</h3>
 * <ol>
 *   <li>Construct once and reuse — the thread survives across start/stop pairs.
 *   <li>Call {@link #start} to begin capture; a callback must be set first.
 *   <li>Call {@link #stop} to halt capture without destroying the thread.
 *   <li>Call {@link #release} when the recorder is no longer needed.
 * </ol>
 */
public class AudioRecorder {

    private static final String TAG = "AudioRecorder";

    public static final int SAMPLE_RATE_HZ = 16_000;
    public static final int CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO;
    public static final int AUDIO_ENCODING = AudioFormat.ENCODING_PCM_16BIT;

    private final Context mContext;
    private final HandlerThread mRecorderThread;
    private final Handler mRecorderHandler;

    @Nullable private volatile AudioChunkCallback mCallback;
    @Nullable private AudioRecord mAudioRecord;
    private volatile boolean mRecording = false;
    private volatile boolean mVadEnabled = false;

    // Bytes per chunk — delivered to the callback on each successful read.
    private int mChunkBytes;

    // The audio source that was actually used for the most recent start() call.
    private int mActiveAudioSource = MediaRecorder.AudioSource.MIC;

    public AudioRecorder(Context context) {
        mContext = context.getApplicationContext();
        mRecorderThread = new HandlerThread("AudioRecorder");
        mRecorderThread.start();
        mRecorderHandler = new Handler(mRecorderThread.getLooper());
    }

    // ─── Public API ──────────────────────────────────────────────────────────────

    /**
     * Register the callback that receives audio chunks. May be set or changed at any time;
     * changes take effect on the next chunk delivery. Pass {@code null} to detach.
     */
    public void setCallback(@Nullable AudioChunkCallback callback) {
        mCallback = callback;
    }

    /**
     * Enable or disable Voice Activity Detection mode.
     * When enabled, the recorder continues capturing but the caller is expected to gate processing
     * on speech presence rather than delivering every chunk downstream. The flag is exposed via
     * {@link #isVadEnabled()} so higher layers can inspect it.
     */
    public void setVadEnabled(boolean enabled) {
        boolean prev = mVadEnabled;
        mVadEnabled = enabled;
        if (prev != enabled) {
            Log.i(TAG, "VAD mode " + (enabled ? "enabled" : "disabled"));
        }
    }

    public boolean isVadEnabled() {
        return mVadEnabled;
    }

    public boolean isRecording() {
        return mRecording;
    }

    /** Returns the audio source used for the most recently started recording session. */
    public int getActiveAudioSource() {
        return mActiveAudioSource;
    }

    /**
     * Begin capturing audio. A no-op if already recording.
     *
     * <p>Attempts to use {@link MediaRecorder.AudioSource#UNPROCESSED} first (raw microphone
     * samples with minimal vendor DSP processing). Falls back to
     * {@link MediaRecorder.AudioSource#MIC} if the device does not support the unprocessed path.
     *
     * @return {@code true} if capture started successfully, {@code false} on any error.
     */
    public synchronized boolean start() {
        if (mRecording) {
            Log.w(TAG, "Already recording — ignoring start()");
            return true;
        }

        int minBytes = AudioRecord.getMinBufferSize(SAMPLE_RATE_HZ, CHANNEL_CONFIG, AUDIO_ENCODING);
        if (minBytes == AudioRecord.ERROR || minBytes == AudioRecord.ERROR_BAD_VALUE) {
            Log.e(TAG, "AudioRecord.getMinBufferSize() failed: " + minBytes);
            return false;
        }

        // Double the minimum to reduce the likelihood of buffer overruns on loaded hardware.
        int bufferBytes = minBytes * 2;
        mChunkBytes = minBytes;

        AudioRecord record = buildAudioRecord(bufferBytes);
        if (record == null) {
            return false;
        }

        mAudioRecord = record;

        record.startRecording();

        // Verify the native layer actually accepted the start. AudioRecord.startRecording() is
        // void and swallows HAL/AudioFlinger errors; getRecordingState() is the only reliable
        // way to detect a silent failure (e.g. mic resource conflict with I2S audio path).
        if (record.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
            Log.e(TAG, "AudioRecord.startRecording() failed — native layer rejected the request "
                    + "(recordingState=" + record.getRecordingState() + ", source=" + mActiveAudioSource + "). "
                    + "Possible cause: microphone held by another process or I2S audio path.");
            record.release();
            mAudioRecord = null;
            return false;
        }

        mRecording = true;
        Log.i(TAG, "Audio capture started — source=" + audioSourceName(mActiveAudioSource)
                + " " + SAMPLE_RATE_HZ + " Hz, " + bufferBytes + "B buffer");

        mRecorderHandler.post(this::readLoop);
        return true;
    }

    /**
     * Stop capturing audio. Safe to call from any thread.
     * The {@link AudioRecord} instance is released; a subsequent {@link #start} call creates a
     * fresh one.
     */
    public synchronized void stop() {
        if (!mRecording) {
            Log.d(TAG, "stop() called while not recording — no-op");
            return;
        }
        mRecording = false;
        if (mAudioRecord != null) {
            try {
                mAudioRecord.stop();
            } catch (IllegalStateException e) {
                Log.w(TAG, "Exception stopping AudioRecord", e);
            }
            mAudioRecord.release();
            mAudioRecord = null;
        }
        Log.i(TAG, "Audio capture stopped");
    }

    /**
     * Release all resources including the background thread. The recorder cannot be used after
     * this call. Call {@link #stop} first if capture is in progress.
     */
    public void release() {
        stop();
        mRecorderThread.quitSafely();
        Log.d(TAG, "AudioRecorder released");
    }

    // ─── Internal ────────────────────────────────────────────────────────────────

    /**
     * Build an {@link AudioRecord}, preferring {@code UNPROCESSED} when the device supports it
     * and falling back to {@code MIC}. Returns {@code null} if neither source initialises.
     */
    @Nullable
    private AudioRecord buildAudioRecord(int bufferBytes) {
        if (supportsUnprocessedSource()) {
            AudioRecord record = tryBuildRecord(
                    MediaRecorder.AudioSource.UNPROCESSED, bufferBytes);
            if (record != null) {
                mActiveAudioSource = MediaRecorder.AudioSource.UNPROCESSED;
                Log.i(TAG, "Using UNPROCESSED audio source (raw microphone, no vendor DSP)");
                return record;
            }
            Log.w(TAG, "UNPROCESSED source advertised but AudioRecord init failed — falling back to MIC");
        } else {
            Log.d(TAG, "UNPROCESSED audio source not supported on this device — using MIC");
        }

        AudioRecord record = tryBuildRecord(MediaRecorder.AudioSource.MIC, bufferBytes);
        if (record != null) {
            mActiveAudioSource = MediaRecorder.AudioSource.MIC;
            return record;
        }

        Log.e(TAG, "Failed to initialise AudioRecord with both UNPROCESSED and MIC sources");
        return null;
    }

    /**
     * Attempt to construct an {@link AudioRecord} with the given source.
     * Returns the instance if {@link AudioRecord#STATE_INITIALIZED}, otherwise releases and
     * returns {@code null}.
     */
    @Nullable
    private AudioRecord tryBuildRecord(int audioSource, int bufferBytes) {
        AudioRecord record = new AudioRecord(
                audioSource,
                SAMPLE_RATE_HZ,
                CHANNEL_CONFIG,
                AUDIO_ENCODING,
                bufferBytes);
        if (record.getState() == AudioRecord.STATE_INITIALIZED) {
            return record;
        }
        Log.w(TAG, "AudioRecord(source=" + audioSourceName(audioSource)
                + ") failed to initialise (state=" + record.getState() + ")");
        record.release();
        return null;
    }

    /**
     * Returns {@code true} if the device explicitly advertises support for the
     * {@link MediaRecorder.AudioSource#UNPROCESSED} capture path.
     * Requires API 24+; returns {@code false} on older devices.
     */
    private boolean supportsUnprocessedSource() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
            return false;
        }
        AudioManager am = (AudioManager) mContext.getSystemService(Context.AUDIO_SERVICE);
        if (am == null) {
            return false;
        }
        String supported = am.getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED);
        return "true".equalsIgnoreCase(supported);
    }

    /**
     * Runs on the recorder thread. Reads chunks from {@link AudioRecord} and forwards them to the
     * registered callback until {@link #mRecording} is cleared.
     */
    private void readLoop() {
        Log.d(TAG, "Read loop started (source=" + audioSourceName(mActiveAudioSource) + ")");

        while (mRecording) {
            AudioRecord record = mAudioRecord;
            if (record == null) break;

            byte[] buf = new byte[mChunkBytes];
            int read = record.read(buf, 0, buf.length);

            if (read > 0) {
                AudioChunkCallback cb = mCallback;
                if (cb != null) {
                    // Wrap in a read-only view so callers cannot modify the backing array.
                    ByteBuffer chunk = ByteBuffer.wrap(buf, 0, read).asReadOnlyBuffer();
                    try {
                        cb.onSuccess(chunk);
                    } catch (Exception e) {
                        Log.e(TAG, "Exception in AudioChunkCallback", e);
                    }
                }
            } else if (read == AudioRecord.ERROR_INVALID_OPERATION
                    || read == AudioRecord.ERROR_BAD_VALUE) {
                Log.e(TAG, "AudioRecord read error: " + read);
                break;
            }
            // read == 0 or ERROR: continue — stop() will clear mRecording.
        }

        Log.d(TAG, "Read loop exited");
    }

    private static String audioSourceName(int source) {
        switch (source) {
            case MediaRecorder.AudioSource.MIC:               return "MIC";
            case MediaRecorder.AudioSource.UNPROCESSED:       return "UNPROCESSED";
            case MediaRecorder.AudioSource.VOICE_RECOGNITION: return "VOICE_RECOGNITION";
            case MediaRecorder.AudioSource.VOICE_COMMUNICATION: return "VOICE_COMMUNICATION";
            default: return "source(" + source + ")";
        }
    }
}
