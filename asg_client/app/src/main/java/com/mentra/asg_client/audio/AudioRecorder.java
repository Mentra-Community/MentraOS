package com.mentra.asg_client.audio;

import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;

import androidx.annotation.Nullable;

import com.mentra.asg_client.io.media.interfaces.AudioChunkCallback;

import java.nio.ByteBuffer;

/**
 * Captures raw PCM audio from the device microphone and delivers chunks to a registered callback.
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

    private final HandlerThread mRecorderThread;
    private final Handler mRecorderHandler;

    @Nullable private volatile AudioChunkCallback mCallback;
    @Nullable private AudioRecord mAudioRecord;
    private volatile boolean mRecording = false;
    private volatile boolean mVadEnabled = false;

    // Bytes per chunk — delivered to the callback on each successful read.
    private int mChunkBytes;

    public AudioRecorder() {
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

    /**
     * Begin capturing audio. A no-op if already recording.
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
        mChunkBytes = minBytes; // deliver chunks at the platform-native granularity

        AudioRecord record = new AudioRecord(
                MediaRecorder.AudioSource.MIC,
                SAMPLE_RATE_HZ,
                CHANNEL_CONFIG,
                AUDIO_ENCODING,
                bufferBytes);

        if (record.getState() != AudioRecord.STATE_INITIALIZED) {
            Log.e(TAG, "AudioRecord failed to initialize (state=" + record.getState() + ")");
            record.release();
            return false;
        }

        mAudioRecord = record;
        mRecording = true;

        record.startRecording();
        Log.i(TAG, "Audio capture started — " + SAMPLE_RATE_HZ + " Hz, " + bufferBytes + "B buffer");

        mRecorderHandler.post(this::readLoop);
        return true;
    }

    /**
     * Stop capturing audio. Safe to call from any thread; blocks until the read loop drains.
     * The {@link AudioRecord} instance is released; a subsequent {@link #start} call creates a
     * fresh one.
     */
    public synchronized void stop() {
        if (!mRecording) {
            Log.d(TAG, "stop() called while not recording — no-op");
            return;
        }
        mRecording = false;
        // AudioRecord.stop() signals the read loop to exit (reads return 0 or error).
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
     * Runs on the recorder thread. Reads chunks from {@link AudioRecord} and forwards them to the
     * registered callback until {@link #mRecording} is cleared.
     */
    private void readLoop() {
        Log.d(TAG, "Read loop started");

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
}
