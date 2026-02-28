package com.mentra.core.utils

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import com.mentra.core.Bridge

/**
 * Android AudioSessionMonitor - maintains API parity with iOS implementation
 *
 * On Android, CTKD automatically handles BT Classic bonding including audio.
 * This class provides a consistent API surface across platforms while being
 * simpler than the iOS version since Android handles most of this automatically.
 */
class AudioSessionMonitor private constructor(private val context: Context) {

    companion object {
        @Volatile
        private var instance: AudioSessionMonitor? = null

        fun getInstance(context: Context): AudioSessionMonitor {
            return instance ?: synchronized(this) {
                instance ?: AudioSessionMonitor(context.applicationContext).also {
                    instance = it
                }
            }
        }
    }

    private val audioManager: AudioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var isMonitoring = false
    private var devicePattern: String? = null
    private var callback: ((Boolean, String?) -> Unit)? = null

    private val audioDeviceReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED -> {
                    val state = intent.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_STATE, -1)
                    handleScoStateChange(state)
                }
                BluetoothDevice.ACTION_ACL_CONNECTED -> {
                    val device: BluetoothDevice? = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
                    device?.let { handleDeviceConnected(it) }
                }
                BluetoothDevice.ACTION_ACL_DISCONNECTED -> {
                    val device: BluetoothDevice? = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
                    device?.let { handleDeviceDisconnected(it) }
                }
            }
        }
    }

    /**
     * Configure audio session for Bluetooth
     * On Android, this is largely handled by the system, so this is mostly a no-op
     * Returns true for API consistency with iOS
     */
    fun configureAudioSession(): Boolean {
        Bridge.log("AudioMonitor: Audio session configured (Android auto-handles)")
        return true
    }

    /**
     * Check if a Bluetooth audio device matching the pattern is connected
     * On Android, we check if SCO (Synchronous Connection-Oriented) audio is active
     */
    fun isAudioDeviceConnected(devicePattern: String): Boolean {
        val isBluetoothA2dpOn = audioManager.isBluetoothA2dpOn
        val isBluetoothScoOn = audioManager.isBluetoothScoOn

        if (isBluetoothA2dpOn || isBluetoothScoOn) {
            // Check if any connected device matches pattern
            val adapter = BluetoothAdapter.getDefaultAdapter()
            adapter?.bondedDevices?.forEach { device ->
                if (device.name?.contains(devicePattern, ignoreCase = true) == true) {
                    Bridge.log("AudioMonitor: Found active audio device: ${device.name}")
                    return true
                }
            }
        }

        Bridge.log("AudioMonitor: No active audio device matching '$devicePattern'")
        return false
    }

    /**
     * Set Bluetooth device as preferred audio device
     * On Android, this is handled automatically by CTKD bonding
     * This method is a no-op for API parity with iOS
     * Returns true if device is bonded (meaning audio will be available)
     */
    fun setAsPreferredAudioOutputDevice(devicePattern: String): Boolean {
        val adapter = BluetoothAdapter.getDefaultAdapter() ?: return false

        adapter.bondedDevices?.forEach { device ->
            if (device.name?.contains(devicePattern, ignoreCase = true) == true) {
                Bridge.log("AudioMonitor: Device '$devicePattern' is bonded, audio routing handled by system")
                return true
            }
        }

        Bridge.log("AudioMonitor: Device '$devicePattern' not bonded")
        return false
    }

    /**
     * Start monitoring for audio device connections/disconnections
     */
    fun startMonitoring(devicePattern: String, callback: (Boolean, String?) -> Unit) {
        if (isMonitoring) {
            Bridge.log("AudioMonitor: Already monitoring")
            return
        }

        this.devicePattern = devicePattern
        this.callback = callback

        val filter = IntentFilter().apply {
            addAction(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED)
            addAction(BluetoothDevice.ACTION_ACL_CONNECTED)
            addAction(BluetoothDevice.ACTION_ACL_DISCONNECTED)
        }

        context.registerReceiver(audioDeviceReceiver, filter)
        isMonitoring = true
        Bridge.log("AudioMonitor: Started monitoring for '$devicePattern'")
    }

    /**
     * Stop monitoring for audio device changes
     */
    fun stopMonitoring() {
        if (!isMonitoring) {
            Bridge.log("AudioMonitor: Not currently monitoring")
            return
        }

        try {
            context.unregisterReceiver(audioDeviceReceiver)
        } catch (e: IllegalArgumentException) {
            Bridge.log("AudioMonitor: Receiver was not registered")
        }

        isMonitoring = false
        devicePattern = null
        callback = null
        Bridge.log("AudioMonitor: Stopped monitoring")
    }

    private fun handleScoStateChange(state: Int) {
        val pattern = devicePattern ?: return

        when (state) {
            AudioManager.SCO_AUDIO_STATE_CONNECTED -> {
                Bridge.log("AudioMonitor: SCO audio connected")
                if (isAudioDeviceConnected(pattern)) {
                    callback?.invoke(true, pattern)
                }
            }
            AudioManager.SCO_AUDIO_STATE_DISCONNECTED -> {
                Bridge.log("AudioMonitor: SCO audio disconnected")
                callback?.invoke(false, null)
            }
        }
    }

    private fun handleDeviceConnected(device: BluetoothDevice) {
        val pattern = devicePattern ?: return

        if (device.name?.contains(pattern, ignoreCase = true) == true) {
            Bridge.log("AudioMonitor: Device '${device.name}' connected")
            callback?.invoke(true, device.name)
        }
    }

    private fun handleDeviceDisconnected(device: BluetoothDevice) {
        val pattern = devicePattern ?: return

        if (device.name?.contains(pattern, ignoreCase = true) == true) {
            Bridge.log("AudioMonitor: Device '${device.name}' disconnected")
            callback?.invoke(false, null)
        }
    }
}
