package com.mentra.core.services

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.mentra.core.Bridge

class ForegroundService : Service() {
    companion object {
        const val CHANNEL_ID = "MentraServiceChannel"
        const val NOTIFICATION_ID = 1001
    }

    override fun onCreate() {
        super.onCreate()
        Bridge.log("ForegroundService: onCreate() called")
        startForegroundWithAutoDetectedType()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Bridge.log("ForegroundService: onStartCommand() called")
        // Re-check permissions in case they changed
        startForegroundWithAutoDetectedType()
        return START_STICKY
    }

    private fun startForegroundWithAutoDetectedType() {
        val serviceType = detectServiceType()

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
                    "ForegroundService: Starting with auto-detected type: ${getServiceTypeName(serviceType)}"
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

        var serviceType = 0

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

        // Check CHANGE_NETWORK_STATE permission - this is a "normal" permission that is
        // auto-granted at install time, but we check it defensively in case this changes.
        // This permission can satisfy the connectedDevice FGS requirement without needing
        // BLUETOOTH_CONNECT, which is a "dangerous" permission that users can deny.
        val hasNetworkStatePermission =
                ContextCompat.checkSelfPermission(
                        this,
                        android.Manifest.permission.CHANGE_NETWORK_STATE
                ) == PackageManager.PERMISSION_GRANTED

        // Use connectedDevice if we have EITHER Bluetooth OR network state permission.
        // This avoids falling back to dataSync (which has a 6-hour timeout on Android 14+)
        // when users deny Bluetooth permissions.
        if (hasBluetoothPermission || hasNetworkStatePermission) {
            serviceType = serviceType or ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
            if (hasBluetoothPermission) {
                Bridge.log("ForegroundService: Added connectedDevice (has Bluetooth permission)")
            } else {
                Bridge.log("ForegroundService: Added connectedDevice (has CHANGE_NETWORK_STATE permission)")
            }
        } else {
            Bridge.log("ForegroundService: No Bluetooth or network state permission for connectedDevice")
        }

        // Check microphone permission
        val hasMicPermission =
                ContextCompat.checkSelfPermission(this, android.Manifest.permission.RECORD_AUDIO) ==
                        PackageManager.PERMISSION_GRANTED

        if (hasMicPermission) {
            serviceType = serviceType or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            Bridge.log("ForegroundService: Added microphone (has RECORD_AUDIO permission)")
        } else {
            Bridge.log("ForegroundService: No microphone permission")
        }

        // Only use dataSync as absolute last resort fallback if no other types were added.
        // WARNING: dataSync has a 6-hour timeout on Android 14+ which will crash the app.
        // This should rarely happen since CHANGE_NETWORK_STATE is a normal permission.
        if (serviceType == 0) {
            serviceType = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            Bridge.log("ForegroundService: WARNING - Using dataSync as fallback (6-hour timeout on Android 14+)")
        }

        return serviceType
    }

    private fun getNotificationText(serviceType: Int): String {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return "Service active"

        val hasConnectedDevice =
                (serviceType and ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE) != 0
        val hasMicrophone = (serviceType and ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE) != 0

        return when {
            hasConnectedDevice && hasMicrophone -> "Glasses & microphone active"
            hasConnectedDevice -> "Smart glasses connected"
            hasMicrophone -> "Microphone active"
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

    override fun onBind(intent: Intent?): IBinder? = null
}
