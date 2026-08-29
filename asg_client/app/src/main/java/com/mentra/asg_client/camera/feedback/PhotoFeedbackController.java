package com.mentra.asg_client.camera.feedback;

import android.os.Handler;
import android.os.SystemClock;
import android.util.Log;

import androidx.annotation.Nullable;

import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.audio.AudioAssets;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * Owns the request-scoped camera prep and snap audio state machine.
 *
 * <p>The controller keeps queued requests isolated, suppresses prep clicks during exposure and
 * snap playback, and guarantees every delayed callback is cancelled on success, failure, timeout,
 * or service cleanup.
 */
public final class PhotoFeedbackController {
    private static final String TAG = "PhotoFeedback";
    static final long FEEDBACK_SAFETY_TIMEOUT_MS = 45_000L;
    static final long SNAP_PREP_RESUME_DELAY_MS = 550L;

    interface Clock {
        long uptimeMillis();

        long elapsedRealtimeNanos();
    }

    /** Opaque handle that binds camera callbacks to one request's feedback lifecycle. */
    public static final class Token {
        private final String mRequestId;
        private final long mGeneration;
        private boolean mPrepClicksActive;
        private boolean mPrepClicksPaused;
        private boolean mExposureStarted;
        private boolean mTerminal;
        private long mPrepClickPlaybackToken;
        private long mSnapPlaybackToken;
        @Nullable private Runnable mPrepClickRunnable;
        @Nullable private Runnable mPrepResumeRunnable;
        @Nullable private Runnable mSnapRunnable;
        @Nullable private Runnable mSnapTrackingRunnable;
        @Nullable private Runnable mSafetyTimeoutRunnable;

        private Token(String requestId, long generation) {
            mRequestId = requestId;
            mGeneration = generation;
        }
    }

    private final Object mLock = new Object();
    @Nullable private final IHardwareManager mHardwareManager;
    private final Handler mHandler;
    private final Clock mClock;
    private final Set<Token> mActiveFeedback = new HashSet<>();
    private final Set<Token> mPlayingSnapFeedback = new HashSet<>();
    private final Map<String, Token> mFeedbackByRequestId = new HashMap<>();
    private long mGeneration;
    private long mPrepSuppressedUntilUptimeMs;
    @Nullable private Token mCurrentPrepFeedback;

    public PhotoFeedbackController(
            @Nullable IHardwareManager hardwareManager, Handler handler) {
        this(
                hardwareManager,
                handler,
                new Clock() {
                    @Override
                    public long uptimeMillis() {
                        return SystemClock.uptimeMillis();
                    }

                    @Override
                    public long elapsedRealtimeNanos() {
                        return SystemClock.elapsedRealtimeNanos();
                    }
                });
    }

    PhotoFeedbackController(
            @Nullable IHardwareManager hardwareManager, Handler handler, Clock clock) {
        mHardwareManager = hardwareManager;
        mHandler = handler;
        mClock = clock;
    }

    /** Starts request-time feedback and returns the token owed an exposure-time snap. */
    @Nullable
    public Token start(String requestId, boolean cameraWarm) {
        if (mHardwareManager == null) {
            Log.w(TAG, "hardwareManager is null, cannot play camera feedback");
            return null;
        }
        if (!mHardwareManager.supportsAudioPlayback()) {
            Log.w(TAG, "hardwareManager does not support audio playback");
            return null;
        }

        synchronized (mLock) {
            Token feedbackToken = new Token(requestId, ++mGeneration);
            mActiveFeedback.add(feedbackToken);
            mFeedbackByRequestId.put(requestId, feedbackToken);
            feedbackToken.mSafetyTimeoutRunnable = () -> stopForTimeout(feedbackToken);
            mHandler.postDelayed(
                    feedbackToken.mSafetyTimeoutRunnable, FEEDBACK_SAFETY_TIMEOUT_MS);

            if (cameraWarm) {
                Log.d(TAG, "Warm capture — snap is waiting for sensor exposure start");
                return feedbackToken;
            }

            // Only the newest cold request owns repeating prep. Keep a displaced request paused
            // so it can resume if the newer request fails before reaching exposure.
            if (mCurrentPrepFeedback != null) {
                pausePrepClicksLocked(mCurrentPrepFeedback);
            }
            Log.d(
                    TAG,
                    "Cold capture — playing prep click every "
                            + AsgConstants.CAMERA_PREP_CLICK_INTERVAL_MS
                            + "ms until sensor exposure starts");
            feedbackToken.mPrepClicksActive = true;
            mCurrentPrepFeedback = feedbackToken;
            if (isPrepSuppressedLocked()) {
                feedbackToken.mPrepClicksPaused = true;
                Log.d(TAG, "Prep click waiting for the active exposure/snap to finish");
                long suppressionDelayMs = prepSuppressionDelayLocked();
                if (suppressionDelayMs >= 0L) {
                    schedulePrepResumeLocked(feedbackToken, suppressionDelayMs);
                }
                return feedbackToken;
            }
            playPrepClickLocked(feedbackToken);
            return feedbackToken;
        }
    }

    /** Anchors the snap to exposure start and offsets playback toward exposure end. */
    public void onExposureStarted(
            @Nullable Token feedbackToken,
            long sensorTimestampNs,
            long estimatedExposureDurationNs) {
        if (feedbackToken == null) {
            return;
        }
        synchronized (mLock) {
            if (feedbackToken.mTerminal || feedbackToken.mExposureStarted) {
                return;
            }
            feedbackToken.mExposureStarted = true;
            if (mCurrentPrepFeedback != null && mCurrentPrepFeedback != feedbackToken) {
                pausePrepClicksLocked(mCurrentPrepFeedback);
            }
            stopPrepClicksLocked(feedbackToken);

            if (estimatedExposureDurationNs <= 0L) {
                Log.d(TAG, "Exposure duration unknown — waiting for JPEG frame to snap");
                return;
            }

            long estimatedExposureMs =
                    Math.max(0L, (estimatedExposureDurationNs + 999_999L) / 1_000_000L);
            long callbackLatencyNs = exposureCallbackLatencyNs(sensorTimestampNs);
            long targetAfterExposureStartNs =
                    Math.max(
                            0L,
                            estimatedExposureDurationNs
                                    - AsgConstants.CAMERA_SNAP_TARGET_LEAD_MS * 1_000_000L);
            long remainingToTargetNs =
                    Math.max(0L, targetAfterExposureStartNs - callbackLatencyNs);
            long snapDelayMs = (remainingToTargetNs + 999_999L) / 1_000_000L;
            String timingSource =
                    "sensor exposure (estimated="
                            + estimatedExposureMs
                            + "ms, callbackLatency="
                            + callbackLatencyNs / 1_000_000.0
                            + "ms, delay="
                            + snapDelayMs
                            + "ms)";
            if (snapDelayMs == 0L) {
                playSnap(feedbackToken, timingSource);
                return;
            }

            feedbackToken.mSnapRunnable = () -> playSnap(feedbackToken, timingSource);
            mHandler.postDelayed(feedbackToken.mSnapRunnable, snapDelayMs);
        }
    }

    /** Plays the snap once from the first reliable exposure or JPEG-frame boundary. */
    public void playSnap(@Nullable Token feedbackToken, String timingSource) {
        if (feedbackToken == null) {
            return;
        }
        synchronized (mLock) {
            if (feedbackToken.mTerminal) {
                return;
            }
            pausePrepClicksLocked(
                    mCurrentPrepFeedback != feedbackToken ? mCurrentPrepFeedback : null);
            finishLocked(feedbackToken);
            Token queuedPrepFeedback = selectPrepFeedbackLocked();
            if (mHardwareManager == null || !mHardwareManager.supportsAudioPlayback()) {
                schedulePrepResumeLocked(queuedPrepFeedback, 0L);
                return;
            }
            Log.d(
                    TAG,
                    "Playing camera snap from "
                            + timingSource
                            + " (feedback gen="
                            + feedbackToken.mGeneration
                            + ")");
            mPrepSuppressedUntilUptimeMs =
                    Math.max(
                            mPrepSuppressedUntilUptimeMs,
                            mClock.uptimeMillis() + SNAP_PREP_RESUME_DELAY_MS);
            feedbackToken.mSnapPlaybackToken =
                    mHardwareManager.playAudioAssetOverlayTracked(
                            AudioAssets.CAMERA_SNAP,
                            AsgConstants.CAMERA_SNAP_PLAYBACK_VOLUME);
            if (feedbackToken.mSnapPlaybackToken > 0L) {
                mPlayingSnapFeedback.add(feedbackToken);
                feedbackToken.mSnapTrackingRunnable =
                        () -> forgetCompletedSnap(feedbackToken);
                mHandler.postDelayed(
                        feedbackToken.mSnapTrackingRunnable, SNAP_PREP_RESUME_DELAY_MS);
            }
            schedulePrepResumeLocked(queuedPrepFeedback, SNAP_PREP_RESUME_DELAY_MS);
        }
    }

    /** Cancels one failed request without stopping unrelated audio. */
    public void stopForFailure(@Nullable Token feedbackToken) {
        if (feedbackToken == null) {
            return;
        }
        synchronized (mLock) {
            if (feedbackToken.mTerminal) {
                stopSnapLocked(feedbackToken);
                return;
            }
            finishLocked(feedbackToken);
            Token queuedPrepFeedback = selectPrepFeedbackLocked();
            schedulePrepResumeLocked(queuedPrepFeedback, 0L);
            Log.d(TAG, "Stopped failed photo feedback (gen=" + feedbackToken.mGeneration + ")");
        }
    }

    /** Cancels feedback associated with the single-flight photo-job timeout. */
    public void stopForTimeout(String requestId) {
        synchronized (mLock) {
            stopForTimeoutLocked(mFeedbackByRequestId.get(requestId));
        }
    }

    /** Cancels all active audio and delayed callbacks during service teardown. */
    public void cleanup() {
        synchronized (mLock) {
            for (Token feedbackToken : new HashSet<>(mActiveFeedback)) {
                finishLocked(feedbackToken);
            }
            for (Token feedbackToken : new HashSet<>(mPlayingSnapFeedback)) {
                stopSnapLocked(feedbackToken);
            }
        }
    }

    private boolean isPrepSuppressedLocked() {
        return prepSuppressionDelayLocked() != 0L;
    }

    private long exposureCallbackLatencyNs(long sensorTimestampNs) {
        if (sensorTimestampNs <= 0L) {
            return 0L;
        }
        long latencyNs = mClock.elapsedRealtimeNanos() - sensorTimestampNs;
        // Some camera devices expose a sensor timestamp in an unspecified timebase. Ignore an
        // implausible delta instead of letting it force every snap to play immediately.
        long maxPlausibleLatencyNs = FEEDBACK_SAFETY_TIMEOUT_MS * 1_000_000L;
        return latencyNs >= 0L && latencyNs <= maxPlausibleLatencyNs ? latencyNs : 0L;
    }

    /** Returns -1 for an active exposure, otherwise the remaining snap suppression time. */
    private long prepSuppressionDelayLocked() {
        for (Token activeFeedback : mActiveFeedback) {
            if (activeFeedback.mExposureStarted && !activeFeedback.mTerminal) {
                return -1L;
            }
        }
        return Math.max(0L, mPrepSuppressedUntilUptimeMs - mClock.uptimeMillis());
    }

    private void playPrepClickLocked(Token feedbackToken) {
        if (!feedbackToken.mPrepClicksActive
                || feedbackToken.mPrepClicksPaused
                || feedbackToken.mTerminal
                || mCurrentPrepFeedback != feedbackToken
                || mHardwareManager == null
                || !mHardwareManager.supportsAudioPlayback()) {
            return;
        }

        if (feedbackToken.mPrepClickPlaybackToken > 0L) {
            mHardwareManager.stopAudioOverlayPlayback(
                    feedbackToken.mPrepClickPlaybackToken);
        }
        feedbackToken.mPrepClickPlaybackToken =
                mHardwareManager.playAudioAssetOverlayTracked(
                        AudioAssets.CAMERA_PREP_CLICK,
                        AsgConstants.CAMERA_PREP_CLICK_PLAYBACK_VOLUME);

        if (feedbackToken.mPrepClickRunnable == null) {
            feedbackToken.mPrepClickRunnable =
                    new Runnable() {
                        @Override
                        public void run() {
                            synchronized (mLock) {
                                if (!feedbackToken.mPrepClicksActive
                                        || feedbackToken.mPrepClicksPaused
                                        || feedbackToken.mTerminal
                                        || mCurrentPrepFeedback != feedbackToken) {
                                    return;
                                }
                                playPrepClickLocked(feedbackToken);
                            }
                        }
                    };
        }
        mHandler.postDelayed(
                feedbackToken.mPrepClickRunnable,
                AsgConstants.CAMERA_PREP_CLICK_INTERVAL_MS);
    }

    private void stopPrepClicksLocked(Token feedbackToken) {
        feedbackToken.mPrepClicksActive = false;
        feedbackToken.mPrepClicksPaused = false;
        if (feedbackToken.mPrepClickRunnable != null) {
            mHandler.removeCallbacks(feedbackToken.mPrepClickRunnable);
        }
        if (feedbackToken.mPrepResumeRunnable != null) {
            mHandler.removeCallbacks(feedbackToken.mPrepResumeRunnable);
            feedbackToken.mPrepResumeRunnable = null;
        }
        if (feedbackToken.mPrepClickPlaybackToken > 0L && mHardwareManager != null) {
            mHardwareManager.stopAudioOverlayPlayback(
                    feedbackToken.mPrepClickPlaybackToken);
            feedbackToken.mPrepClickPlaybackToken = 0L;
        }
        if (mCurrentPrepFeedback == feedbackToken) {
            mCurrentPrepFeedback = null;
        }
    }

    private void pausePrepClicksLocked(@Nullable Token feedbackToken) {
        if (feedbackToken == null
                || !feedbackToken.mPrepClicksActive
                || feedbackToken.mTerminal) {
            return;
        }
        feedbackToken.mPrepClicksPaused = true;
        if (feedbackToken.mPrepClickRunnable != null) {
            mHandler.removeCallbacks(feedbackToken.mPrepClickRunnable);
        }
        if (feedbackToken.mPrepClickPlaybackToken > 0L && mHardwareManager != null) {
            mHardwareManager.stopAudioOverlayPlayback(
                    feedbackToken.mPrepClickPlaybackToken);
            feedbackToken.mPrepClickPlaybackToken = 0L;
        }
    }

    private void schedulePrepResumeLocked(@Nullable Token feedbackToken, long delayMs) {
        if (feedbackToken == null
                || !feedbackToken.mPrepClicksActive
                || !feedbackToken.mPrepClicksPaused
                || feedbackToken.mExposureStarted
                || feedbackToken.mTerminal
                || mCurrentPrepFeedback != feedbackToken) {
            return;
        }
        if (feedbackToken.mPrepResumeRunnable != null) {
            mHandler.removeCallbacks(feedbackToken.mPrepResumeRunnable);
        }
        feedbackToken.mPrepResumeRunnable =
                () -> {
                    synchronized (mLock) {
                        feedbackToken.mPrepResumeRunnable = null;
                        if (!feedbackToken.mPrepClicksActive
                                || feedbackToken.mExposureStarted
                                || feedbackToken.mTerminal
                                || mCurrentPrepFeedback != feedbackToken) {
                            return;
                        }
                        long suppressionDelayMs = prepSuppressionDelayLocked();
                        if (suppressionDelayMs < 0L) {
                            return;
                        }
                        if (suppressionDelayMs > 0L) {
                            schedulePrepResumeLocked(feedbackToken, suppressionDelayMs);
                            return;
                        }
                        feedbackToken.mPrepClicksPaused = false;
                        playPrepClickLocked(feedbackToken);
                    }
                };
        mHandler.postDelayed(feedbackToken.mPrepResumeRunnable, Math.max(0L, delayMs));
    }

    @Nullable
    private Token selectPrepFeedbackLocked() {
        if (canOwnPrepLocked(mCurrentPrepFeedback)) {
            return mCurrentPrepFeedback;
        }

        Token newestPausedFeedback = null;
        for (Token activeFeedback : mActiveFeedback) {
            if (!canOwnPrepLocked(activeFeedback)) {
                continue;
            }
            if (newestPausedFeedback == null
                    || activeFeedback.mGeneration > newestPausedFeedback.mGeneration) {
                newestPausedFeedback = activeFeedback;
            }
        }
        mCurrentPrepFeedback = newestPausedFeedback;
        return newestPausedFeedback;
    }

    private boolean canOwnPrepLocked(@Nullable Token feedbackToken) {
        return feedbackToken != null
                && feedbackToken.mPrepClicksActive
                && !feedbackToken.mExposureStarted
                && !feedbackToken.mTerminal;
    }

    private void forgetCompletedSnap(Token feedbackToken) {
        synchronized (mLock) {
            feedbackToken.mSnapTrackingRunnable = null;
            feedbackToken.mSnapPlaybackToken = 0L;
            mPlayingSnapFeedback.remove(feedbackToken);
        }
    }

    private void stopSnapLocked(Token feedbackToken) {
        if (feedbackToken.mSnapTrackingRunnable != null) {
            mHandler.removeCallbacks(feedbackToken.mSnapTrackingRunnable);
            feedbackToken.mSnapTrackingRunnable = null;
        }
        if (feedbackToken.mSnapPlaybackToken > 0L && mHardwareManager != null) {
            mHardwareManager.stopAudioOverlayPlayback(feedbackToken.mSnapPlaybackToken);
            feedbackToken.mSnapPlaybackToken = 0L;
        }
        mPlayingSnapFeedback.remove(feedbackToken);
    }

    private void finishLocked(Token feedbackToken) {
        feedbackToken.mTerminal = true;
        if (feedbackToken.mSnapRunnable != null) {
            mHandler.removeCallbacks(feedbackToken.mSnapRunnable);
            feedbackToken.mSnapRunnable = null;
        }
        if (feedbackToken.mSafetyTimeoutRunnable != null) {
            mHandler.removeCallbacks(feedbackToken.mSafetyTimeoutRunnable);
            feedbackToken.mSafetyTimeoutRunnable = null;
        }
        stopPrepClicksLocked(feedbackToken);
        mActiveFeedback.remove(feedbackToken);
        mFeedbackByRequestId.remove(feedbackToken.mRequestId, feedbackToken);
    }

    private void stopForTimeout(@Nullable Token feedbackToken) {
        if (feedbackToken == null) {
            return;
        }
        synchronized (mLock) {
            stopForTimeoutLocked(feedbackToken);
        }
    }

    private void stopForTimeoutLocked(@Nullable Token feedbackToken) {
        if (feedbackToken == null || feedbackToken.mTerminal) {
            return;
        }
        finishLocked(feedbackToken);
        Token queuedPrepFeedback = selectPrepFeedbackLocked();
        schedulePrepResumeLocked(queuedPrepFeedback, 0L);
        Log.d(
                TAG,
                "Stopped timed-out photo feedback (requestId="
                        + feedbackToken.mRequestId
                        + ", gen="
                        + feedbackToken.mGeneration
                        + ")");
    }
}
