package com.mentra.bluetoothsdk.services

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.LocationManager
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.mentra.bluetoothsdk.Bridge
import com.mentra.bluetoothsdk.debug.BleTraceLogger

class ForegroundService : Service() {
    companion object {
        const val CHANNEL_ID = "MentraServiceChannel"
        const val NOTIFICATION_ID = 1001
        const val ACTION_REFRESH_TYPES =
                "com.mentra.bluetoothsdk.services.action.REFRESH_FOREGROUND_SERVICE_TYPES"

        internal fun bootstrapServiceType(): Int =
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC

        internal fun preferredServiceType(
                hasConnectedDeviceAccess: Boolean,
                hasMicrophoneAccess: Boolean,
                hasLocationAccess: Boolean,
                includeMediaPlayback: Boolean = true,
        ): Int {
            var serviceType = 0

            if (includeMediaPlayback) {
                serviceType =
                        serviceType or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
            }
            if (hasConnectedDeviceAccess) {
                serviceType =
                        serviceType or ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
            }
            if (hasMicrophoneAccess) {
                serviceType = serviceType or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            }
            if (hasLocationAccess) {
                serviceType = serviceType or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            }

            return if (serviceType == 0) bootstrapServiceType() else serviceType
        }
    }

    private var locationTypeRequested = false

    override fun onCreate() {
        super.onCreate()
        Bridge.log("ForegroundService: onCreate() called")
        BleTraceLogger.logLifecycle(this, "ForegroundService", "service_create")
        // Enter the foreground immediately with a type that has no runtime
        // prerequisites. onStartCommand() replaces this bootstrap type with the
        // eligible long-running types, deliberately omitting dataSync so Android 15's
        // six-hour dataSync timer no longer applies.
        startForegroundWithType(bootstrapServiceType())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Bridge.log("ForegroundService: onStartCommand() called")
        BleTraceLogger.logLifecycle(
                this,
                "ForegroundService",
                "service_start_command",
                mapOf("action" to intent?.action, "flags" to flags, "startId" to startId)
        )
        if (intent?.action == ACTION_REFRESH_TYPES) {
            // This action is only sent while the host Activity is foregrounded. Android 14+
            // rejects adding a while-in-use location type from the background.
            locationTypeRequested = true
        }
        // Re-check permissions in case they changed
        startForegroundWithAutoDetectedType()
        return START_STICKY
    }

    private fun startForegroundWithAutoDetectedType() {
        startForegroundWithType(detectServiceType())
    }

    private fun startForegroundWithType(serviceType: Int) {
        createNotificationChannel()

        val notification =
                NotificationCompat.Builder(this, CHANNEL_ID)
                        .setContentTitle("Mentra Connected")
                        .setContentText(getNotificationText(serviceType))
                        .setSmallIcon(android.R.drawable.ic_dialog_info)
                        .setPriority(NotificationCompat.PRIORITY_LOW)
                        .setOngoing(true)
                        .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            Bridge.log(
                    "ForegroundService: Starting with type: ${getServiceTypeName(serviceType)}"
            )
            startForeground(NOTIFICATION_ID, notification, serviceType)
        } else {
            Bridge.log("ForegroundService: Starting foreground (pre-Q, no service types)")
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun detectServiceType(): Int {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            return 0 // No service types before Android Q
        }

        // Audio prompts can be initiated by glasses while the host Activity is
        // backgrounded. mediaPlayback has no runtime prerequisite, so keep it
        // active on the existing Mentra service for the entire connected
        // session rather than trying to launch a second service after a wake
        // phrase arrives.
        Bridge.log("ForegroundService: Added mediaPlayback (supports background audio)")

        // Check Bluetooth permissions
        val hasBluetoothPermission =
                when {
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
                        ContextCompat.checkSelfPermission(
                                this,
                                android.Manifest.permission.BLUETOOTH_CONNECT
                        ) == PackageManager.PERMISSION_GRANTED
                    }
                    else -> {
                        ContextCompat.checkSelfPermission(
                                this,
                                android.Manifest.permission.BLUETOOTH
                        ) == PackageManager.PERMISSION_GRANTED
                    }
                }

        // These normal permissions satisfy the connectedDevice FGS prerequisite without
        // waiting for a runtime Bluetooth grant. CHANGE_WIFI_STATE is declared by the SDK;
        // CHANGE_NETWORK_STATE is also accepted when a host app already declares it.
        val hasConnectedDeviceManifestPermission =
                ContextCompat.checkSelfPermission(
                        this,
                        android.Manifest.permission.CHANGE_NETWORK_STATE
                ) == PackageManager.PERMISSION_GRANTED ||
                        ContextCompat.checkSelfPermission(
                                this,
                                android.Manifest.permission.CHANGE_WIFI_STATE
                        ) == PackageManager.PERMISSION_GRANTED

        // Use connectedDevice if we have either Bluetooth or a qualifying normal permission.
        // This avoids falling back to dataSync (which has a six-hour timeout on Android 15+)
        // when users deny Bluetooth permissions.
        val hasConnectedDeviceAccess =
                hasBluetoothPermission || hasConnectedDeviceManifestPermission
        if (hasConnectedDeviceAccess) {
            if (hasBluetoothPermission) {
                Bridge.log("ForegroundService: Added connectedDevice (has Bluetooth permission)")
            } else {
                Bridge.log("ForegroundService: Added connectedDevice (has network control permission)")
            }
        } else {
            Bridge.log("ForegroundService: No qualifying permission for connectedDevice")
        }

        // Check microphone permission
        val hasMicPermission =
                ContextCompat.checkSelfPermission(this, android.Manifest.permission.RECORD_AUDIO) ==
                        PackageManager.PERMISSION_GRANTED

        if (hasMicPermission) {
            Bridge.log("ForegroundService: Added microphone (has RECORD_AUDIO permission)")
        } else {
            Bridge.log("ForegroundService: No microphone permission")
        }

        val hasLocationPermission =
                ContextCompat.checkSelfPermission(
                        this,
                        android.Manifest.permission.ACCESS_FINE_LOCATION
                ) == PackageManager.PERMISSION_GRANTED ||
                        ContextCompat.checkSelfPermission(
                                this,
                                android.Manifest.permission.ACCESS_COARSE_LOCATION
                        ) == PackageManager.PERMISSION_GRANTED
        val locationManager = getSystemService(LocationManager::class.java)
        val isLocationEnabled = locationManager?.isLocationEnabled == true

        val hasLocationAccess = locationTypeRequested && hasLocationPermission && isLocationEnabled
        if (hasLocationAccess) {
            Bridge.log("ForegroundService: Added location (has foreground location permission)")
        } else {
            Bridge.log(
                    "ForegroundService: No location type " +
                            "(requested=$locationTypeRequested, permission=$hasLocationPermission, enabled=$isLocationEnabled)"
            )
        }

        return preferredServiceType(
                hasConnectedDeviceAccess = hasConnectedDeviceAccess,
                hasMicrophoneAccess = hasMicPermission,
                hasLocationAccess = hasLocationAccess,
        )
    }

    private fun getNotificationText(serviceType: Int): String {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return "Service active"

        val hasConnectedDevice =
                (serviceType and ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE) != 0
        val hasMicrophone = (serviceType and ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE) != 0
        val hasLocation = (serviceType and ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION) != 0
        val hasMediaPlayback =
                (serviceType and ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK) != 0

        return when {
            hasConnectedDevice && hasMicrophone && hasLocation ->
                    "Glasses, microphone & location active"
            hasConnectedDevice && hasLocation -> "Smart glasses & location active"
            hasMicrophone && hasLocation -> "Microphone & location active"
            hasLocation -> "Location active"
            hasConnectedDevice && hasMicrophone -> "Glasses & microphone active"
            hasConnectedDevice -> "Smart glasses connected"
            hasMicrophone -> "Microphone active"
            hasMediaPlayback -> "Audio playback active"
            else -> "Syncing data"
        }
    }

    private fun getServiceTypeName(serviceType: Int): String {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return "legacy"

        val types = mutableListOf<String>()
        if (serviceType and ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC != 0)
                types.add("dataSync")
        if (serviceType and ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE != 0)
                types.add("connectedDevice")
        if (serviceType and ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE != 0)
                types.add("microphone")
        if (serviceType and ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION != 0)
                types.add("location")
        if (serviceType and ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK != 0)
                types.add("mediaPlayback")

        return types.joinToString("|")
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel =
                    NotificationChannel(
                                    CHANNEL_ID,
                                    "Mentra Service",
                                    NotificationManager.IMPORTANCE_LOW
                            )
                            .apply { description = "Maintains connection to smart glasses" }

            val notificationManager = getSystemService(NotificationManager::class.java)
            notificationManager.createNotificationChannel(channel)
        }
    }

    override fun onDestroy() {
        BleTraceLogger.logLifecycle(this, "ForegroundService", "service_destroy")
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
