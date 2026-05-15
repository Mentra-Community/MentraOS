package com.mentra.crust.services

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Handler
import android.os.HandlerThread
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.text.TextUtils
import android.util.Base64
import android.util.Log
import com.mentra.crust.CrustModule

class NotificationListener private constructor(private val context: Context) {
  companion object {
    private const val TAG = "CrustNotificationListener"
    private const val PREFS_NAME = "mentra_crust_notification_prefs"
    private const val PREF_NOTIFICATIONS_ENABLED = "notifications_enabled"
    private const val PREF_NOTIFICATIONS_BLOCKLIST = "notifications_blocklist"

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

  // Deduplication tracking with dedicated background thread. Using HandlerThread
  // keeps the service independent from the app lifecycle on newer Android versions.
  private val notificationBuffer = mutableMapOf<String, Runnable>()
  private val notificationThread = HandlerThread("NotificationHandler").apply { start() }
  private val notificationHandler = Handler(notificationThread.looper)
  private val duplicateThresholdMs = 200L

  private val preferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

  @Volatile private var notificationsEnabled = preferences.getBoolean(PREF_NOTIFICATIONS_ENABLED, false)
  @Volatile
  private var notificationsBlocklist =
    preferences.getStringSet(PREF_NOTIFICATIONS_BLOCKLIST, emptySet())?.toSet() ?: emptySet()

  /** Keep MentraOS notification settings in Crust instead of Bluetooth SDK state. */
  fun setNotificationConfig(enabled: Boolean, blocklist: List<String>) {
    val blocklistSet = blocklist.toSet()
    notificationsEnabled = enabled
    notificationsBlocklist = blocklistSet
    preferences
      .edit()
      .putBoolean(PREF_NOTIFICATIONS_ENABLED, enabled)
      .putStringSet(PREF_NOTIFICATIONS_BLOCKLIST, blocklistSet)
      .apply()
  }

  /** Check if notification listener permission is granted. */
  fun hasNotificationListenerPermission(): Boolean {
    val packageName = context.packageName
    val flat = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners")

    if (!TextUtils.isEmpty(flat)) {
      val names = flat.split(":")
      for (name in names) {
        val componentName = ComponentName.unflattenFromString(name)
        if (componentName != null && TextUtils.equals(packageName, componentName.packageName)) {
          return true
        }
      }
    }
    return false
  }

  /** Open notification listener settings. */
  fun openNotificationListenerSettings() {
    val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    context.startActivity(intent)
  }

  /** Add a listener for notifications. */
  fun addListener(listener: OnNotificationReceivedListener) {
    if (!listeners.contains(listener)) {
      listeners.add(listener)
    }
  }

  /** Remove a listener. */
  fun removeListener(listener: OnNotificationReceivedListener) {
    listeners.remove(listener)
  }

  /** Allowlist for messaging apps that should not be blocked even if they match system patterns. */
  private val messagingAppAllowlist =
    setOf(
      "com.google.android.apps.messaging",
      "com.samsung.android.messaging",
      "com.android.mms",
      "com.google.android.gm",
      "com.samsung.android.email.provider",
    )

  /** Check if this is a system package that should be blocked. */
  private fun isSystemPackageToBlock(packageName: String): Boolean {
    if (messagingAppAllowlist.contains(packageName)) {
      return false
    }

    val pkg = packageName.lowercase()
    return pkg.contains("google") || pkg.contains("samsung") || pkg.contains(".sec.")
  }

  /** Called internally by the service when a notification is posted. */
  internal fun onNotificationPosted(sbn: StatusBarNotification) {
    val packageName = sbn.packageName
    Log.d(TAG, "Received notification from $packageName (key: ${sbn.key})")

    if (isSystemPackageToBlock(packageName)) {
      Log.d(TAG, "Blocking system package: $packageName")
      return
    }

    if (notificationsBlocklist.contains(packageName)) {
      Log.d(TAG, "Notification in blocklist, returning")
      return
    }

    if (!notificationsEnabled) {
      Log.d(TAG, "Notifications disabled globally")
      return
    }

    val notification = sbn.notification
    val extras = notification.extras
    val title = extras.getCharSequence("android.title")?.toString() ?: ""
    val text = extras.getCharSequence("android.text")?.toString() ?: ""

    if (title.isEmpty() && text.isEmpty()) {
      Log.d(TAG, "Ignoring empty notification")
      return
    }

    if (text.matches(Regex("^\\d+ new messages$"))) {
      Log.d(TAG, "Ignoring summary notification: $text")
      return
    }

    val packageManager = context.packageManager
    val appName =
      try {
        val appInfo = packageManager.getApplicationInfo(packageName, 0)
        packageManager.getApplicationLabel(appInfo).toString()
      } catch (_: Exception) {
        packageName
      }

    val notificationKey = "$packageName|$title|$text"

    synchronized(notificationBuffer) {
      notificationBuffer[notificationKey]?.let {
        notificationHandler.removeCallbacks(it)
        notificationBuffer.remove(notificationKey)
      }

      val task =
        Runnable {
          try {
            Log.d(TAG, "Processing buffered notification from $appName")
            CrustModule.emitPhoneNotification(
              notificationKey = sbn.key,
              packageName = packageName,
              appName = appName,
              title = title,
              text = text,
              timestamp = sbn.postTime,
            )

            val notificationData =
              NotificationData(
                packageName = packageName,
                title = title,
                text = text,
                timestamp = sbn.postTime,
                id = sbn.id,
                tag = sbn.tag,
              )
            listeners.forEach { listener ->
              listener.onNotificationReceived(notificationData)
            }
          } catch (e: Exception) {
            Log.e(TAG, "Error processing notification: ${e.message}", e)
          } finally {
            synchronized(notificationBuffer) {
              notificationBuffer.remove(notificationKey)
            }
          }
        }

      notificationBuffer[notificationKey] = task
      Log.d(TAG, "Buffering notification (${duplicateThresholdMs}ms delay)")
      notificationHandler.postDelayed(task, duplicateThresholdMs)
    }
  }

  /** Called internally by the service when a notification is removed. */
  internal fun onNotificationRemoved(sbn: StatusBarNotification) {
    val packageName = sbn.packageName
    val notificationKey = sbn.key

    Log.d(TAG, "Notification removed - package: $packageName, key: $notificationKey")

    CrustModule.emitPhoneNotificationDismissed(
      notificationKey = notificationKey,
      packageName = packageName,
    )

    listeners.forEach { listener -> listener.onNotificationRemoved(packageName, sbn.id) }
  }

  /** Interface for notification callbacks. */
  interface OnNotificationReceivedListener {
    fun onNotificationReceived(notification: NotificationData)
    fun onNotificationRemoved(packageName: String, notificationId: Int) {}
  }

  /** Data class for notification info. */
  data class NotificationData(
    val packageName: String,
    val title: String,
    val text: String,
    val timestamp: Long,
    val id: Int,
    val tag: String?,
  )

  /** Get all installed apps with details. */
  fun getInstalledApps(): List<Map<String, Any?>> {
    val packageManager = context.packageManager
    val packages = packageManager.getInstalledApplications(PackageManager.GET_META_DATA)
    val blocklist = notificationsBlocklist

    return packages
      .filter { it.flags and ApplicationInfo.FLAG_SYSTEM == 0 }
      .map { appInfo ->
        val icon =
          try {
            val drawable = packageManager.getApplicationIcon(appInfo.packageName)
            val bitmap = (drawable as? android.graphics.drawable.BitmapDrawable)?.bitmap
            if (bitmap != null) {
              val outputStream = java.io.ByteArrayOutputStream()
              bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, outputStream)
              val byteArray = outputStream.toByteArray()
              "data:image/png;base64," + Base64.encodeToString(byteArray, Base64.NO_WRAP)
            } else {
              null
            }
          } catch (_: Exception) {
            null
          }

        mapOf(
          "packageName" to appInfo.packageName,
          "appName" to packageManager.getApplicationLabel(appInfo).toString(),
          "isBlocked" to blocklist.contains(appInfo.packageName),
          "icon" to icon,
        )
      }
      .sortedBy { it["appName"] as String }
  }

  /** Clean up resources when the service is destroyed. */
  fun cleanup() {
    Log.d(TAG, "Cleaning up notification handler thread")
    synchronized(notificationBuffer) {
      notificationBuffer.values.forEach { notificationHandler.removeCallbacks(it) }
      notificationBuffer.clear()
    }
    notificationThread.quitSafely()
  }
}

/** The actual NotificationListenerService implementation. */
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
    Log.d("CrustNotificationListener", "NotificationListenerService connected and ready")
  }

  override fun onListenerDisconnected() {
    super.onListenerDisconnected()
    Log.d("CrustNotificationListener", "NotificationListenerService disconnected, requesting rebind")
    requestRebind(ComponentName(this, NotificationListenerServiceImpl::class.java))
  }

  override fun onDestroy() {
    super.onDestroy()
    Log.d("CrustNotificationListener", "NotificationListenerService being destroyed")
    NotificationListener.getInstance(applicationContext).cleanup()
  }
}
