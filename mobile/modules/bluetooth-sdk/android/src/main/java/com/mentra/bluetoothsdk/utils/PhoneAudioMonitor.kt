package com.mentra.core.utils

import android.content.Context
import android.media.AudioManager
import android.media.AudioPlaybackConfiguration
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.mentra.core.Bridge

/**
 * PhoneAudioMonitor - Monitors system audio playback state
 *
 * Used to detect when the phone is playing audio (music, podcasts, etc.)
 * so we can temporarily suspend the LC3 microphone on MentraLive glasses
 * to avoid overloading the MCU when both A2DP output and LC3 mic input
 * are active simultaneously.
 *
 * This class mirrors the iOS PhoneAudioMonitor.swift implementation.
 */
class PhoneAudioMonitor private constructor(private val context: Context) {

    companion object {
        private const val TAG = "PhoneAudioMonitor"

        @Volatile
        private var instance: PhoneAudioMonitor? = null

        @JvmStatic
        fun getInstance(context: Context): PhoneAudioMonitor {
            return instance ?: synchronized(this) {
                instance ?: PhoneAudioMonitor(context.applicationContext).also {
                    instance = it
                }
            }
        }
    }

    // Listener callback for audio state changes
    interface Listener {
        fun onPhoneAudioStateChanged(isPlaying: Boolean)
    }

    private val audioManager: AudioManager =
        context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val mainHandler = Handler(Looper.getMainLooper())

    private var listener: Listener? = null
    private var isMonitoring = false
    private var lastKnownState = false

    // Rate limiting: max 1 state change notification per 500ms
    // If state changes rapidly (true/false/true), we wait and send the final state
    private var lastNotificationTime = 0L
    private var pendingStateRunnable: Runnable? = null
    private var pendingState: Boolean? = null
    private val STATE_CHANGE_MIN_INTERVAL_MS = 500L

    // Hold-off period: When our app signals it's about to play audio, ignore STOPPED
    // reports for this duration. This handles the brief gap during codec transitions
    // when one audio interrupts another (system reports 0 configs briefly).
    private var audioStartHoldoffUntil = 0L
    private val AUDIO_START_HOLDOFF_MS = 1000L // 1 second hold-off when starting audio

    // AudioPlaybackCallback for API 26+ (real-time detection)
    private var playbackCallback: AudioManager.AudioPlaybackCallback? = null

    // Fallback polling for older devices or edge cases
    private var pollingRunnable: Runnable? = null
    private val POLLING_INTERVAL_MS = 1000L // 1 second polling fallback

    /**
     * Check if any audio is currently playing on the device (including our own app)
     * On Android, isMusicActive and AudioPlaybackCallback detect ALL apps including ours,
     * so we don't need to manually track our own app's audio like on iOS.
     */
    fun isPlaying(): Boolean {
        return audioManager.isMusicActive
    }

    /**
     * Notify the monitor that our own app started/stopped playing audio
     * Called from RN AudioPlaybackService via Bridge
     *
     * On Android, isMusicActive already detects our app's audio, but we use this signal
     * to set a hold-off period during audio transitions. When one audio interrupts another,
     * there's a brief gap where the system reports 0 active configs (codec is switching).
     * The hold-off prevents us from reporting STOPPED during this transition.
     */
    fun setOwnAppAudioPlaying(playing: Boolean) {
        Bridge.log("$TAG: Own app audio -> ${if (playing) "PLAYING" else "STOPPED"}")

        if (playing) {
            // Starting audio: set hold-off to ignore STOPPED during codec transition
            audioStartHoldoffUntil = System.currentTimeMillis() + AUDIO_START_HOLDOFF_MS
            Bridge.log("$TAG: Set audio start hold-off for ${AUDIO_START_HOLDOFF_MS}ms")

            // Cancel any pending STOPPED notification since we're about to play
            if (pendingState == false) {
                pendingStateRunnable?.let { mainHandler.removeCallbacks(it) }
                pendingStateRunnable = null
                pendingState = null
                Bridge.log("$TAG: Cancelled pending STOPPED notification")
            }

            // If we were in STOPPED state, notify PLAYING immediately
            if (!lastKnownState) {
                doNotify(true)
            }
        } else {
            // Stopping audio: clear hold-off and check actual state
            audioStartHoldoffUntil = 0L
            notifyIfStateChanged(isPlaying())
        }
    }

    /**
     * Start monitoring for phone audio playback changes
     *
     * @param listener Callback to receive audio state change notifications
     */
    fun startMonitoring(listener: Listener) {
        if (isMonitoring) {
            Bridge.log("$TAG: Already monitoring")
            return
        }

        this.listener = listener
        this.lastKnownState = isPlaying()
        this.isMonitoring = true

        Bridge.log("$TAG: Starting audio playback monitoring (initial state: ${if (lastKnownState) "playing" else "not playing"})")

        // Use AudioPlaybackCallback for API 26+ (real-time detection)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            playbackCallback = object : AudioManager.AudioPlaybackCallback() {
                override fun onPlaybackConfigChanged(configs: MutableList<AudioPlaybackConfiguration>?) {
                    super.onPlaybackConfigChanged(configs)
                    handlePlaybackConfigChanged(configs)
                }
            }
            audioManager.registerAudioPlaybackCallback(playbackCallback!!, mainHandler)
            Bridge.log("$TAG: Registered AudioPlaybackCallback (API 26+)")
        }

        // Also start polling as a fallback/supplement
        // Some audio sources might not trigger the callback reliably
        startPolling()
    }

    /**
     * Stop monitoring for phone audio playback changes
     */
    fun stopMonitoring() {
        if (!isMonitoring) {
            Bridge.log("$TAG: Not currently monitoring")
            return
        }

        Bridge.log("$TAG: Stopping audio playback monitoring")

        // Unregister callback
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && playbackCallback != null) {
            audioManager.unregisterAudioPlaybackCallback(playbackCallback!!)
            playbackCallback = null
        }

        // Stop polling
        stopPolling()

        // Cancel any pending state notification
        pendingStateRunnable?.let { mainHandler.removeCallbacks(it) }
        pendingStateRunnable = null
        pendingState = null

        listener = null
        isMonitoring = false
    }

    /**
     * Handle playback configuration changes from AudioPlaybackCallback
     * Note: This callback fires when audio players are added/removed, but may not
     * fire reliably when other apps pause (they keep the player, just paused).
     * We rely on polling for pause detection.
     */
    private fun handlePlaybackConfigChanged(configs: MutableList<AudioPlaybackConfiguration>?) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // Log active configs for debugging
            val activeCount = configs?.size ?: 0
            Bridge.log("$TAG: Playback config changed, ${activeCount} active configs")
        }

        // Use the combined isPlaying() which includes ownAppAudioPlaying
        // This prevents the system callback from triggering STOPPED when our app is still playing
        notifyIfStateChanged(isPlaying())
    }

    /**
     * Start polling isMusicActive as a fallback mechanism
     */
    private fun startPolling() {
        pollingRunnable = object : Runnable {
            override fun run() {
                if (!isMonitoring) return

                notifyIfStateChanged(isPlaying())

                mainHandler.postDelayed(this, POLLING_INTERVAL_MS)
            }
        }
        mainHandler.postDelayed(pollingRunnable!!, POLLING_INTERVAL_MS)
    }

    /**
     * Stop the polling mechanism
     */
    private fun stopPolling() {
        pollingRunnable?.let { mainHandler.removeCallbacks(it) }
        pollingRunnable = null
    }

    /**
     * Notify listener if state has changed, with rate limiting and hold-off protection.
     *
     * Hold-off: When our app signals it's about to play audio, we ignore STOPPED reports
     * for a short period to handle codec transition gaps.
     *
     * Rate limiting: Max 1 notification per 500ms. If state changes rapidly, we send the final state.
     */
    private fun notifyIfStateChanged(isPlaying: Boolean) {
        if (isPlaying == lastKnownState) return

        val now = System.currentTimeMillis()

        // Hold-off protection: Don't report STOPPED during audio start hold-off period
        // This handles the brief gap when one audio interrupts another (codec switching)
        if (!isPlaying && audioStartHoldoffUntil > now) {
            Bridge.log("$TAG: Ignoring STOPPED during audio start hold-off (${audioStartHoldoffUntil - now}ms remaining)")
            return
        }

        val timeSinceLastNotification = now - lastNotificationTime

        // Cancel any pending notification - we'll either send immediately or schedule new one
        pendingStateRunnable?.let { mainHandler.removeCallbacks(it) }
        pendingStateRunnable = null
        pendingState = null

        if (timeSinceLastNotification >= STATE_CHANGE_MIN_INTERVAL_MS) {
            // It's been long enough, notify immediately
            doNotify(isPlaying)
        } else {
            // Too soon, schedule for later
            val delay = STATE_CHANGE_MIN_INTERVAL_MS - timeSinceLastNotification
            pendingState = isPlaying
            pendingStateRunnable = Runnable {
                pendingState?.let { state ->
                    // Re-check hold-off at execution time
                    if (!state && audioStartHoldoffUntil > System.currentTimeMillis()) {
                        Bridge.log("$TAG: Ignoring scheduled STOPPED during audio start hold-off")
                        pendingStateRunnable = null
                        pendingState = null
                        return@Runnable
                    }
                    doNotify(state)
                }
                pendingStateRunnable = null
                pendingState = null
            }
            mainHandler.postDelayed(pendingStateRunnable!!, delay)
        }
    }

    /**
     * Actually send the notification to listener
     */
    private fun doNotify(isPlaying: Boolean) {
        lastKnownState = isPlaying
        lastNotificationTime = System.currentTimeMillis()
        Bridge.log("$TAG: Audio state changed -> ${if (isPlaying) "PLAYING" else "STOPPED"}")

        listener?.onPhoneAudioStateChanged(isPlaying)
    }

    /**
     * Force a state check and notify if changed.
     * Call this when the app returns to foreground to catch any changes
     * that may have been missed while backgrounded.
     */
    fun checkStateNow() {
        if (!isMonitoring) return
        Bridge.log("$TAG: Forcing state check")
        notifyIfStateChanged(isPlaying())
    }

    /**
     * Clean up resources
     */
    fun destroy() {
        stopMonitoring()
        instance = null
    }
}
