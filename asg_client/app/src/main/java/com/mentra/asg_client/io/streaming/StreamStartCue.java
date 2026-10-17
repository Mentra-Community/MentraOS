package com.mentra.asg_client.io.streaming;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.audio.AudioAssets;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;

import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;

/**
 * Plays the recording-started cue before RTMP/SRT capture opens the microphone.
 *
 * <p>{@link #handoff} always returns without blocking the lifecycle thread. When sound is enabled
 * it schedules a worker; that worker is the only caller of {@code startStream}.
 */
public final class StreamStartCue {
    private static final String TAG = "StreamStartCue";

    private static final Executor DEFAULT_WORKER =
            Executors.newSingleThreadExecutor(
                    runnable -> {
                        Thread thread = new Thread(runnable, "stream-start-cue");
                        thread.setDaemon(true);
                        return thread;
                    });

    private static final AtomicReference<Executor> WORKER = new AtomicReference<>(DEFAULT_WORKER);

    private StreamStartCue() {}

    /** Tests replace the worker so the scheduled cue can run inline. */
    public static void setWorkerForTest(Executor worker) {
        WORKER.set(worker == null ? DEFAULT_WORKER : worker);
    }

    /**
     * Start the publisher after the cue, or immediately when there is nothing to play.
     *
     * @param lifecycleHandler thread that owns stream state and {@code startStream}
     * @param hardware playback target; ignored when sound is disabled
     * @param soundEnabled whether the user asked for the start cue
     * @param stillStarting true only while this start attempt is still current
     * @param startStream opens the publisher; closed over the URL and continuation
     */
    public static void handoff(
            Handler lifecycleHandler,
            IHardwareManager hardware,
            boolean soundEnabled,
            BooleanSupplier stillStarting,
            Runnable startStream) {
        if (lifecycleHandler == null || startStream == null) {
            return;
        }
        boolean canPlay =
                soundEnabled && hardware != null && hardware.supportsAudioPlayback();
        if (!canPlay) {
            if (Looper.myLooper() == lifecycleHandler.getLooper()) {
                startStream.run();
            } else {
                lifecycleHandler.post(startStream);
            }
            return;
        }
        WORKER.get()
                .execute(
                        () -> {
                            if (stillStarting != null && !stillStarting.getAsBoolean()) {
                                return;
                            }
                            try {
                                hardware.playAudioAssetAndAwait(
                                        AudioAssets.VIDEO_RECORDING_START,
                                        AsgConstants.STREAM_START_CUE_WAIT_MS);
                            } catch (RuntimeException e) {
                                Log.e(TAG, "Livestream start cue failed", e);
                            }
                            lifecycleHandler.post(
                                    () -> {
                                        if (stillStarting == null || stillStarting.getAsBoolean()) {
                                            startStream.run();
                                        }
                                    });
                        });
    }
}
