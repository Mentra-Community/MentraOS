package com.mentra.core.services

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.drawable.BitmapDrawable
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.text.TextUtils
import android.util.Base64
import com.mentra.core.Bridge
import com.mentra.core.CoreManager
import java.io.ByteArrayOutputStream

class NotificationListener private constructor(private val context: Context) {

    companion object {
        @Volatile private var instance: NotificationListener? = null

        fun getInstance(context: Context): NotificationListener {
            return instance
                    ?: synchronized(this) {
                        instance
                                ?: NotificationListener(context.applicationContext).also {
                                    instance = it
                                }
                    }
        }
    }

    private val listeners = mutableListOf<OnNotificationReceivedListener>()

    // Deduplication tracking with dedicated background thread
    // Using HandlerThread instead of main looper to ensure the service works
    // independently of the app's lifecycle (fixes Android 15 background crashes)
    private val notificationBuffer = mutableMapOf<String, Runnable>()
    private val notificationThread = HandlerThread("NotificationHandler").apply { start() }
    private val notificationHandler = Handler(notificationThread.looper)
    private val DUPLICATE_THRESHOLD_MS = 200L

    /** Check if notification listener permission is granted */
    fun hasNotificationListenerPermission(): Boolean {
        val packageName = context.packageName
        val flat =
                Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners")

        if (!TextUtils.isEmpty(flat)) {
            val names = flat.split(":")
            for (name in names) {
                val componentName = ComponentName.unflattenFromString(name)
                if (componentName != null) {
                    if (TextUtils.equals(packageName, componentName.packageName)) {
                        return true
                    }
                }
            }
        }
        return false
    }

    /** Open notification listener settings */
    fun openNotificationListenerSettings() {
        val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }

    /** Add a listener for notifications */
    fun addListener(listener: OnNotificationReceivedListener) {
        if (!listeners.contains(listener)) {
            listeners.add(listener)
        }
    }

    /** Remove a listener */
    fun removeListener(listener: OnNotificationReceivedListener) {
        listeners.remove(listener)
    }

    /** Allowlist for messaging apps that should NOT be blocked even if they match Google/Samsung patterns */
    private val messagingAppAllowlist = setOf(
        "com.google.android.apps.messaging",   // Google Messages (default SMS on Pixel/stock Android)
        "com.samsung.android.messaging",       // Samsung Messages (default SMS on Samsung)
        "com.android.mms",                     // Stock Android SMS app
        "com.google.android.gm",               // Gmail
        "com.samsung.android.email.provider",  // Samsung Email
    )

    /** Check if this is a system package that should be blocked */
    private fun isSystemPackageToBlock(packageName: String): Boolean {
        // First check if the package is in the messaging allowlist
        if (messagingAppAllowlist.contains(packageName)) {
            return false
        }

        val pkg = packageName.lowercase()
        return pkg.contains("google") || pkg.contains("samsung") || pkg.contains(".sec.")
    }

    /** Called internally by the service when a notification is posted */
    internal fun onNotificationPosted(sbn: StatusBarNotification) {
        val packageName = sbn.packageName
        Bridge.log("NOTIF: Received notification from $packageName (key: ${sbn.key})")

        // Filter system packages
        if (isSystemPackageToBlock(packageName)) {
            Bridge.log("NOTIF: Blocking system package: $packageName")
            return
        }

        // Check blocklist
        val blocklist = CoreManager.getInstance().notificationsBlocklist
        if (blocklist.contains(packageName)) {
            Bridge.log("NOTIF: Notification in blocklist, returning")
            return
        }

        // Check if notifications enabled globally
        if (!CoreManager.getInstance().notificationsEnabled) {
            Bridge.log("NOTIF: Notifications disabled globally")
            return
        }

        // Extract notification data
        val notification = sbn.notification
        val extras = notification.extras
        val title = extras.getString("android.title") ?: ""
        val textCharSequence = extras.getCharSequence("android.text")
        val text = textCharSequence?.toString() ?: ""

        // Ignore empty notifications
        if (title.isEmpty() || text.isEmpty()) {
            Bridge.log("NOTIF: Ignoring empty notification")
            return
        }

        // Ignore WhatsApp summary notifications (e.g., "5 new messages")
        if (text.matches(Regex("^\\d+ new messages$"))) {
            Bridge.log("NOTIF: Ignoring summary notification: $text")
            return
        }

        // Get app name
        val packageManager = context.packageManager
        val appName = try {
            val appInfo = packageManager.getApplicationInfo(packageName, 0)
            packageManager.getApplicationLabel(appInfo).toString()
        } catch (e: Exception) {
            packageName
        }

        // Deduplication key
        val notificationKey = "$packageName|$title|$text"

        synchronized(notificationBuffer) {
            // Remove previous notification with same key
            notificationBuffer[notificationKey]?.let {
                notificationHandler.removeCallbacks(it)
                notificationBuffer.remove(notificationKey)
            }

            // Create delayed task
            val task = Runnable {
                try {
                    Bridge.log("NOTIF: Processing buffered notification from $appName")
                    // Send to server via Bridge
                    Bridge.sendPhoneNotification(
                        notificationKey = sbn.key,
                        packageName = packageName,
                        appName = appName,
                        title = title,
                        text = text,
                        timestamp = sbn.postTime
                    )

                    // Notify listeners (for future extensibility)
                    val notificationData = NotificationData(
                        packageName = packageName,
                        title = title,
                        text = text,
                        timestamp = sbn.postTime,
                        id = sbn.id,
                        tag = sbn.tag
                    )
                    listeners.forEach { listener ->
                        listener.onNotificationReceived(notificationData)
                    }
                } catch (e: Exception) {
                    Bridge.log("NOTIF: Error processing notification: ${e.message}")
                } finally {
                    synchronized(notificationBuffer) {
                        notificationBuffer.remove(notificationKey)
                    }
                }
            }

            // Buffer for 200ms to deduplicate
            notificationBuffer[notificationKey] = task
            Bridge.log("NOTIF: Buffering notification (${DUPLICATE_THRESHOLD_MS}ms delay)")
            notificationHandler.postDelayed(task, DUPLICATE_THRESHOLD_MS)
        }
    }

    /** Called internally by the service when a notification is removed */
    internal fun onNotificationRemoved(sbn: StatusBarNotification) {
        val packageName = sbn.packageName
        val notificationKey = sbn.key

        Bridge.log("NOTIF: Notification removed - package: $packageName, key: $notificationKey")

        // Send dismissal to server
        Bridge.sendPhoneNotificationDismissed(
            notificationKey = notificationKey,
            packageName = packageName
        )

        // Notify listeners
        listeners.forEach { listener -> listener.onNotificationRemoved(packageName, sbn.id) }
    }

    /** Interface for notification callbacks */
    interface OnNotificationReceivedListener {
        fun onNotificationReceived(notification: NotificationData)
        fun onNotificationRemoved(packageName: String, notificationId: Int) {}
    }

    /** Data class for notification info */
    data class NotificationData(
            val packageName: String,
            val title: String,
            val text: String,
            val timestamp: Long,
            val id: Int,
            val tag: String?
    )

    /** Get all installed apps with details */
    fun getInstalledApps(): List<Map<String, Any?>> {
        val packageManager = context.packageManager
        val packages = packageManager.getInstalledApplications(PackageManager.GET_META_DATA)
        val blocklist = CoreManager.getInstance().notificationsBlocklist

        return packages
                .filter { it.flags and ApplicationInfo.FLAG_SYSTEM == 0 } // Filter out system apps
                .map { appInfo ->
                    val icon =
                            try {
                                val drawable =
                                        packageManager.getApplicationIcon(appInfo.packageName)
                                // Convert drawable to base64 string
                                val bitmap =
                                        (drawable as? android.graphics.drawable.BitmapDrawable)
                                                ?.bitmap
                                if (bitmap != null) {
                                    val outputStream = java.io.ByteArrayOutputStream()
                                    bitmap.compress(
                                            android.graphics.Bitmap.CompressFormat.PNG,
                                            100,
                                            outputStream
                                    )
                                    val byteArray = outputStream.toByteArray()
                                    "data:image/png;base64," +
                                            android.util.Base64.encodeToString(
                                                    byteArray,
                                                    android.util.Base64.NO_WRAP
                                            )
                                } else {
                                    null
                                }
                            } catch (e: Exception) {
                                null
                            }

                    mapOf(
                            "packageName" to appInfo.packageName,
                            "appName" to packageManager.getApplicationLabel(appInfo).toString(),
                            "isBlocked" to blocklist.contains(appInfo.packageName),
                            "icon" to icon
                    )
                }
                .sortedBy { it["appName"] as String }
    }

    /** Clean up resources when the service is destroyed */
    fun cleanup() {
        Bridge.log("NOTIF: Cleaning up notification handler thread")
        synchronized(notificationBuffer) {
            // Remove all pending callbacks
            notificationBuffer.values.forEach { notificationHandler.removeCallbacks(it) }
            notificationBuffer.clear()
        }
        // Safely quit the handler thread
        notificationThread.quitSafely()
    }
}

/** The actual NotificationListenerService implementation */
class NotificationListenerServiceImpl : NotificationListenerService() {

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        super.onNotificationPosted(sbn)
        NotificationListener.getInstance(applicationContext).onNotificationPosted(sbn)
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification) {
        super.onNotificationRemoved(sbn)
        NotificationListener.getInstance(applicationContext).onNotificationRemoved(sbn)
    }

    override fun onListenerConnected() {
        super.onListenerConnected()
        Bridge.log("NOTIF: NotificationListenerService connected and ready")
    }

    override fun onListenerDisconnected() {
        super.onListenerDisconnected()
        Bridge.log("NOTIF: NotificationListenerService disconnected, requesting rebind")
        // Service was disconnected, request rebind
        requestRebind(ComponentName(this, NotificationListenerServiceImpl::class.java))
    }

    override fun onDestroy() {
        super.onDestroy()
        Bridge.log("NOTIF: NotificationListenerService being destroyed")
        // Clean up the handler thread when service is destroyed
        NotificationListener.getInstance(applicationContext).cleanup()
    }
}
