package com.mentra.bluetoothsdk.utils.audio

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.mentra.bluetoothsdk.Bridge
import com.mentra.bluetoothsdk.utils.NativeLog as Log
import java.util.concurrent.atomic.AtomicLong

/**
 * Notices audio route changes for [PcmStreamManager]: the set of output devices changing
 * (glasses or other Bluetooth audio, wired or USB headsets connecting or disconnecting) and a
 * phone call starting or ending. Each change bumps [currentGeneration] and aborts streams that
 * haven't received audio yet.
 *
 * Other audio-mode changes (communication mode toggled for a microphone or by a player) are not
 * route changes: the engine reconfigures audio before playback and on wake-word detections, and
 * counting those would close a prewarmed stream exactly when it is needed. Same rule as iOS,
 * which only reacts when the route's output ports change, a call starts or ends, or the audio
 * session is interrupted.
 *
 * Android 12+ reports mode changes through a listener; on older versions the call state is
 * compared whenever [currentGeneration] is read, which [PcmStreamManager] does before a
 * stream's first write.
 */
internal object AudioRouteWatcher {
    private const val TAG = "AudioRouteWatcher"

    private val generation = AtomicLong(0)
    @Volatile private var audioManager: AudioManager? = null
    private var knownOutputs: Set<String> = emptySet()
    private var inCall = false

    /** Audio modes that mean a phone call is ringing or active. */
    private fun isCallMode(mode: Int): Boolean =
            mode == AudioManager.MODE_RINGTONE ||
                    mode == AudioManager.MODE_IN_CALL ||
                    mode == AudioManager.MODE_CALL_SCREENING ||
                    mode == AudioManager.MODE_CALL_REDIRECT

    /** Start listening (idempotent). Without a context (no host), routes are not watched. */
    fun ensureStarted() {
        if (audioManager != null) return
        val context =
                try {
                    Bridge.getContext()
                } catch (_: IllegalStateException) {
                    return
                }
        start(context)
    }

    @Synchronized
    private fun start(context: Context) {
        if (audioManager != null) return
        val manager = context.getSystemService(AudioManager::class.java) ?: return
        val handler = Handler(Looper.getMainLooper())
        knownOutputs = outputs(manager)
        inCall = isCallMode(manager.mode)
        audioManager = manager
        try {
            manager.registerAudioDeviceCallback(
                    object : AudioDeviceCallback() {
                        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) =
                                checkOutputs()

                        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>?) =
                                checkOutputs()
                    },
                    handler,
            )
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                manager.addOnModeChangedListener({ command -> handler.post(command) }) { checkCall() }
            }
        } catch (e: Exception) {
            Log.w(TAG, "could not watch audio routes", e)
        }
    }

    /** Route generation; changes on every detected route change. */
    fun currentGeneration(): Long {
        checkCall()
        return generation.get()
    }

    private fun outputs(manager: AudioManager): Set<String> =
            manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
                    .map { "${it.type}:${it.id}" }
                    .toSet()

    private fun checkOutputs() {
        val manager = audioManager ?: return
        val current = outputs(manager)
        synchronized(this) {
            // Registration replays the connected devices; only a real difference counts.
            if (current == knownOutputs) return
            knownOutputs = current
        }
        changed("output devices changed")
    }

    private fun checkCall() {
        val manager = audioManager ?: return
        val call = isCallMode(manager.mode)
        synchronized(this) {
            if (call == inCall) return
            inCall = call
        }
        changed(if (call) "phone call started" else "phone call ended")
    }

    private fun changed(reason: String) {
        generation.incrementAndGet()
        PcmStreamManager.abortStreamsWithoutAudio(reason)
    }
}
