package com.mentra.asg_client.audio;

import android.app.AppOpsManager;
import android.content.Context;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Process;
import android.util.Log;

import androidx.annotation.Nullable;

import com.mentra.asg_client.io.media.interfaces.AudioChunkCallback;

import java.nio.ByteBuffer;

/**
 * Captures raw PCM audio from the device microphone and delivers chunks to a registered callback.
 *
 * <h3>Audio source selection</h3>
 * Uses {@link MediaRecorder.AudioSource#MIC}. The MTK audio stack on Mentra Live does not expose
 * the {@code UNPROCESSED} capture path, so the standard microphone source is always used.
 *
 * <h3>I2S gate</h3>
 * On Mentra Live the microphone is routed through the BES MCU's I2S bus. AudioFlinger cannot
 * create an input track ({@code createRecord}) until the BES chip has been commanded to open the
 * I2S path (i.e. {@code mh_starti2s} sent over UART). Two optional {@link Runnable} callbacks can
 * be injected via {@link #setI2SAudioCallbacks}: the first is invoked before AudioRecord is
 * constructed (to send {@code mh_starti2s}), and the second is invoked after recording stops (to
 * send {@code mh_stopi2s}).  AudioRecord construction is deferred by
 * {@link #I2S_OPEN_DELAY_MS} to give the hardware time to route the signal before AudioFlinger
 * tries to open the track.
 *
 * <h3>Configuration</h3>
 * Records at 44.1 kHz, 16-bit mono PCM — matching the factory test configuration used to
 * validate the microphone on Mentra Live hardware. Buffer size equals the platform minimum
 * (same size used for both the {@link AudioRecord} buffer and per-chunk reads).
 *
 * <h3>Threading</h3>
 * All {@link AudioRecord} reads run on a dedicated {@link HandlerThread} ({@code "AudioRecorder"}).
 * {@link #start} and {@link #stop} are safe to call from any thread. The {@link AudioChunkCallback}
 * is invoked on the recorder thread, so callers should not block there for long.
 *
 * <h3>Lifecycle</h3>
 * <ol>
 *   <li>Construct once and reuse — the thread survives across start/stop pairs.
 *   <li>Optionally call {@link #setI2SAudioCallbacks} to wire I2S gate control.
 *   <li>Call {@link #start} to begin capture; a callback must be set first.
 *   <li>Call {@link #stop} to halt capture without destroying the thread.
 *   <li>Call {@link #release} when the recorder is no longer needed.
 * </ol>
 */
public class AudioRecorder {

    private static final String TAG = "AudioRecorder";

    public static final int SAMPLE_RATE_HZ = 44_100;
    public static final int CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO;
    public static final int AUDIO_ENCODING = AudioFormat.ENCODING_PCM_16BIT;

    /**
     * Delay between sending {@code mh_starti2s} and constructing {@link AudioRecord}.
     * The BES chip and MTK audio HAL need time to negotiate I2S clocks and register the
     * input device with AudioFlinger before a record track can be created.
     */
    private static final long I2S_OPEN_DELAY_MS = 1_500L;

    private final Context mContext;
    private final HandlerThread mRecorderThread;
    private final Handler mRecorderHandler;

    @Nullable private volatile AudioChunkCallback mCallback;
    @Nullable private volatile AudioRecord mAudioRecord;
    private volatile boolean mRecording = false;
    private volatile boolean mVadEnabled = false;

    // Bytes per chunk — delivered to the callback on each successful read.
    private int mChunkBytes;

    // The audio source that was actually used for the most recent start() call.
    private int mActiveAudioSource = MediaRecorder.AudioSource.MIC;

    // Optional I2S gate callbacks (Mentra Live specific).
    @Nullable private Runnable mI2SEnable;
    @Nullable private Runnable mI2SDisable;

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
     * Register optional I2S gate callbacks for hardware that routes the microphone through an
     * external MCU (Mentra Live: BES chip via I2S).
     *
     * <p>{@code onEnable} is called immediately when {@link #start} is invoked, before the
     * {@link AudioRecord} is constructed. {@code onDisable} is called after recording stops.
     * Both may be {@code null} if I2S control is not needed on the current device.
     */
    public void setI2SAudioCallbacks(@Nullable Runnable onEnable, @Nullable Runnable onDisable) {
        mI2SEnable = onEnable;
        mI2SDisable = onDisable;
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
     * <p>If I2S gate callbacks are registered, the enable callback is fired immediately and
     * {@link AudioRecord} construction is deferred by {@link #I2S_OPEN_DELAY_MS} to allow the BES
     * chip time to open the I2S audio path before AudioFlinger tries to create a record track.
     * Without this delay {@code createRecord} returns {@code -1} (NO_INIT) on Mentra Live.
     *
     * @return {@code true} if capture was started (or will start) successfully;
     *         {@code false} if a fatal error occurred before the I2S gate was opened.
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

        mChunkBytes = minBytes;
        final int bufferBytes = minBytes;
        mRecording = true;

        // Send mh_starti2s to the BES MCU so it opens the I2S audio path before AudioFlinger
        // tries to create a record track. Without this the mic is unavailable on Mentra Live.
        if (mI2SEnable != null) {
            Log.d(TAG, "Opening I2S mic path (mh_starti2s) — AudioRecord will follow in "
                    + I2S_OPEN_DELAY_MS + "ms");
            mI2SEnable.run();
        }

        // Defer AudioRecord construction to the recorder thread so the main thread is not blocked
        // and the I2S path has time to initialize before we open the track.
        mRecorderHandler.postDelayed(() -> {
            if (!mRecording) {
                Log.d(TAG, "Recording cancelled during I2S open delay — aborting");
                return;
            }

            logAppOpsStatus(mContext);

            AudioRecord record = buildAudioRecord(bufferBytes);
            if (record == null) {
                Log.e(TAG, "AudioRecord unavailable — all source/rate combinations rejected by AudioFlinger");
                mRecording = false;
                if (mI2SDisable != null) mI2SDisable.run();
                return;
            }

            mAudioRecord = record;
            record.startRecording();
            Log.i(TAG, "Audio capture started — source=" + audioSourceName(mActiveAudioSource)
                    + " " + record.getSampleRate() + " Hz, " + record.getBufferSizeInFrames()
                    + " frames buffer");
            readLoop();
        }, I2S_OPEN_DELAY_MS);

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
        if (mI2SDisable != null) {
            Log.d(TAG, "Closing I2S mic path (mh_stopi2s)");
            mI2SDisable.run();
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
     * Log AppOps status for RECORD_AUDIO to help diagnose permission-level failures.
     * On Mentra Live the op mode should be MODE_ALLOWED (0); MODE_IGNORED (1) or
     * MODE_ERRORED (2) would explain AudioFlinger returning -1.
     */
    private void logAppOpsStatus(Context context) {
        try {
            AppOpsManager appOps = (AppOpsManager) context.getSystemService(Context.APP_OPS_SERVICE);
            if (appOps == null) { Log.w(TAG, "AppOpsManager unavailable"); return; }
            int mode = appOps.checkOp(AppOpsManager.OPSTR_RECORD_AUDIO,
                    Process.myUid(), context.getPackageName());
            String modeStr;
            switch (mode) {
                case AppOpsManager.MODE_ALLOWED:  modeStr = "ALLOWED";  break;
                case AppOpsManager.MODE_IGNORED:  modeStr = "IGNORED";  break;
                case AppOpsManager.MODE_ERRORED:  modeStr = "ERRORED";  break;
                case AppOpsManager.MODE_DEFAULT:  modeStr = "DEFAULT";  break;
                default:                          modeStr = "UNKNOWN(" + mode + ")"; break;
            }
            Log.i(TAG, "AppOps RECORD_AUDIO: " + modeStr + " (uid=" + Process.myUid() + ")");
        } catch (Exception e) {
            Log.w(TAG, "AppOps check failed", e);
        }
    }

    /**
     * Probe every practical combination of audio source and sample rate until one succeeds.
     * AudioFlinger on Mentra Live returns -1 (NO_INIT) for sources or rates that the audio HAL
     * does not support, so we try the most common combinations in priority order.
     * Returns the first successfully initialized {@link AudioRecord}, or {@code null} if all fail.
     */
    @Nullable
    private AudioRecord buildAudioRecord(int bufferBytes) {
        // (source, rate) pairs in priority order.  MIC/44100 is the factory-test config.
        int[] sources = {
            MediaRecorder.AudioSource.MIC,
            MediaRecorder.AudioSource.DEFAULT,
            MediaRecorder.AudioSource.CAMCORDER,
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
        };
        int[] rates = { 44_100, 16_000, 48_000, 8_000 };

        for (int source : sources) {
            for (int rate : rates) {
                int buf = AudioRecord.getMinBufferSize(rate, CHANNEL_CONFIG, AUDIO_ENCODING);
                if (buf == AudioRecord.ERROR || buf == AudioRecord.ERROR_BAD_VALUE) continue;
                // Use at least the requested bufferBytes to honour the caller's sizing.
                int actualBuf = Math.max(buf, bufferBytes);

                try {
                    AudioRecord record = new AudioRecord(
                            source, rate, CHANNEL_CONFIG, AUDIO_ENCODING, actualBuf);
                    if (record.getState() == AudioRecord.STATE_INITIALIZED) {
                        mActiveAudioSource = source;
                        mChunkBytes = buf; // chunk at this rate's min buffer
                        Log.i(TAG, "AudioRecord init SUCCESS — source=" + audioSourceName(source)
                                + " rate=" + rate + "Hz buf=" + actualBuf + "B");
                        return record;
                    }
                    Log.d(TAG, "AudioRecord source=" + audioSourceName(source)
                            + " rate=" + rate + " → state=UNINITIALIZED, skipping");
                    record.release();
                } catch (Exception e) {
                    Log.d(TAG, "AudioRecord source=" + audioSourceName(source)
                            + " rate=" + rate + " → exception: " + e.getMessage());
                }
            }
        }
        Log.e(TAG, "All AudioRecord source/rate combinations failed — mic not accessible on this device");
        return null;
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
