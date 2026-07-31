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
import java.util.concurrent.ConcurrentHashMap

class NotificationListener private constructor(private val context: Context) {
  companion object {
    private const val TAG = "CrustNotificationListener"
    private const val PREFS_NAME = "mentra_crust_notification_prefs"
    private const val PREF_LISTENER_ENABLED = "notification_listener_enabled"
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

    /**
     * Persist desired notification state without constructing the listener.
     * The component stays enabled so Android can show it in notification-access
     * Settings, but its service process only starts after access is granted.
     */
    fun setNotificationConfig(
      context: Context,
      listenerEnabled: Boolean,
      blocklist: List<String>,
    ) {
      val applicationContext = context.applicationContext
      val blocklistSet = blocklist.toSet()
      applicationContext
        .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        .edit()
        .putBoolean(PREF_LISTENER_ENABLED, listenerEnabled)
        .putStringSet(PREF_NOTIFICATIONS_BLOCKLIST, blocklistSet)
        .commit()

      applyConfigToExisting(listenerEnabled, blocklistSet)

      val permissionGranted = hasNotificationListenerPermission(applicationContext)
      val shouldRun = listenerEnabled && permissionGranted

      // Deliver the kill switch before disabling the component so an already
      // bound isolated listener stops immediately instead of waiting for the OS
      // to tear it down. Do not send without access: an explicit broadcast to
      // the :notif receiver would otherwise start that process unnecessarily.
      if (permissionGranted) {
        NotificationProcessBridge.sendConfig(
          applicationContext,
          listenerEnabled,
          blocklistSet,
        )
      }

      updateComponentState(
        applicationContext,
        enabled = listenerEnabled,
        requestRebind = shouldRun,
      )

      if (!shouldRun) {
        Log.d(TAG, "Notification listener prerequisites not met; service will not start")
        return
      }
    }

    /**
     * Reconcile the component after an OS notification-access check.
     *
     * The permission flow calls this when the app returns from Settings, so a
     * newly granted listener starts immediately. Without permission the service
     * is not rebound and the isolated process is never started.
     */
    fun refreshComponentForPermission(context: Context): Boolean {
      val applicationContext = context.applicationContext
      val permissionGranted = hasNotificationListenerPermission(applicationContext)
      val preferences = applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      val listenerEnabled = preferences.getBoolean(PREF_LISTENER_ENABLED, false)
      val blocklist =
        preferences.getStringSet(PREF_NOTIFICATIONS_BLOCKLIST, emptySet())?.toSet() ?: emptySet()

      val shouldRun = listenerEnabled && permissionGranted
      if (permissionGranted) {
        NotificationProcessBridge.sendConfig(
          applicationContext,
          listenerEnabled,
          blocklist,
        )
      }
      updateComponentState(
        applicationContext,
        enabled = listenerEnabled,
        requestRebind = shouldRun,
      )
      return permissionGranted
    }

    fun openNotificationListenerSettings(context: Context) {
      val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.applicationContext.startActivity(intent)
    }

    private fun hasNotificationListenerPermission(context: Context): Boolean {
      val packageName = context.packageName
      val flat = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners")
      if (TextUtils.isEmpty(flat)) return false

      return flat.split(":").any { name ->
        ComponentName.unflattenFromString(name)?.packageName == packageName
      }
    }

    private fun updateComponentState(
      context: Context,
      enabled: Boolean,
      requestRebind: Boolean,
    ) {
      val component = ComponentName(context, NotificationListenerServiceImpl::class.java)
      val newState =
        if (enabled) {
          PackageManager.COMPONENT_ENABLED_STATE_ENABLED
        } else {
          PackageManager.COMPONENT_ENABLED_STATE_DISABLED
        }
      val packageManager = context.packageManager
      if (packageManager.getComponentEnabledSetting(component) != newState) {
        packageManager.setComponentEnabledSetting(
          component,
          newState,
          PackageManager.DONT_KILL_APP,
        )
      }
      if (enabled && requestRebind) {
        runCatching { NotificationListenerService.requestRebind(component) }
          .onFailure { Log.w(TAG, "Could not request notification-listener rebind", it) }
      }
    }

    internal fun applyConfigToExisting(
      listenerEnabled: Boolean,
      blocklist: Set<String>,
    ) {
      synchronized(this) {
        instance?.applyConfig(listenerEnabled, blocklist)
      }
    }

    fun isListenerEnabled(context: Context): Boolean {
      val preferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      return preferences.getBoolean(PREF_LISTENER_ENABLED, false) &&
        hasNotificationListenerPermission(context)
    }

    /**
     * Read installed-app metadata without constructing the service singleton.
     *
     * These APIs run in the React Native process. The notification singleton
     * belongs exclusively to :notif; constructing it here would create an
     * orphaned HandlerThread that no service lifecycle ever destroys.
     */
    fun getInstalledApps(context: Context): List<Map<String, Any?>> {
      val applicationContext = context.applicationContext
      val packageManager = applicationContext.packageManager
      val packages = packageManager.getInstalledApplications(PackageManager.GET_META_DATA)
      val blocklist =
        applicationContext
          .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
          .getStringSet(PREF_NOTIFICATIONS_BLOCKLIST, emptySet())
          ?.toSet() ?: emptySet()

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

    /** Dispose the process singleton so a service rebind gets a live HandlerThread. */
    fun destroyInstance() {
      synchronized(this) {
        instance?.cleanup()
        instance = null
      }
    }
  }

  private val listeners = mutableListOf<OnNotificationReceivedListener>()
  private val appNameCache = ConcurrentHashMap<String, String>()

  // Deduplication tracking with dedicated background thread. Using HandlerThread
  // keeps the service independent from the app lifecycle on newer Android versions.
  private val notificationBuffer = mutableMapOf<String, Runnable>()
  private val notificationThread = HandlerThread("NotificationHandler").apply { start() }
  private val notificationHandler = Handler(notificationThread.looper)
  private val duplicateThresholdMs = 200L

  private val preferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

  @Volatile private var listenerEnabled = preferences.getBoolean(PREF_LISTENER_ENABLED, false)
  @Volatile
  private var notificationsBlocklist =
    preferences.getStringSet(PREF_NOTIFICATIONS_BLOCKLIST, emptySet())?.toSet() ?: emptySet()

  private fun applyConfig(
    listenerEnabled: Boolean,
    blocklist: Set<String>,
  ) {
    this.listenerEnabled = listenerEnabled
    notificationsBlocklist = blocklist
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
  /**
   * @param importance NotificationManager.IMPORTANCE_* from the ranking, or null
   *   when unavailable. Preferred over the deprecated Notification.priority,
   *   which reads 0 for channel-based notifications.
   */
  internal fun onNotificationPosted(sbn: StatusBarNotification, importance: Int? = null) {
    if (!listenerEnabled) {
      Log.d(TAG, "Notification listener disabled")
      return
    }

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

    val notificationKey = "$packageName|$title|$text"

    synchronized(notificationBuffer) {
      notificationBuffer[notificationKey]?.let {
        notificationHandler.removeCallbacks(it)
        notificationBuffer.remove(notificationKey)
      }

      val task =
        Runnable {
          try {
            // Config can change during the debounce window. Recheck here so a
            // kill-switch or blocklist update cannot leak an already-buffered
            // notification after it takes effect.
            if (!listenerEnabled || notificationsBlocklist.contains(packageName)) {
              return@Runnable
            }

            // PackageManager label resolution can take tens of milliseconds on
            // low-end devices. It belongs on this handler thread, not the
            // NotificationListenerService main callback, and only once per app.
            val appName =
              appNameCache.getOrPut(packageName) {
                try {
                  val packageManager = context.packageManager
                  val appInfo = packageManager.getApplicationInfo(packageName, 0)
                  packageManager.getApplicationLabel(appInfo).toString()
                } catch (_: Exception) {
                  packageName
                }
              }
            Log.d(TAG, "Processing buffered notification from $appName")
            CrustModule.emitPhoneNotification(
              context = context,
              notificationKey = sbn.key,
              packageName = packageName,
              appName = appName,
              title = title,
              text = text,
              timestamp = sbn.postTime,
              // Map channel importance onto the priority scale consumers
              // already understand (LOW/MIN are negative). Fall back to the
              // deprecated field only when no ranking was available.
              priority = importance?.let { it - 3 } ?: notification.priority,
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
    if (!listenerEnabled) {
      return
    }

    val packageName = sbn.packageName
    val notificationKey = sbn.key

    Log.d(TAG, "Notification removed - package: $packageName, key: $notificationKey")

    CrustModule.emitPhoneNotificationDismissed(
      context = context,
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
    // Channel importance, not Notification.priority: the latter was deprecated
    // at API 26 and reads 0 for apps that express intent through a channel
    // instead, which would make every consumer treat them as ordinary. Only the
    // service can see the ranking, so it is resolved here and passed down.
    NotificationListener.getInstance(applicationContext).onNotificationPosted(sbn, importanceOf(sbn))
  }

  /** IMPORTANCE_* for this notification, or null when the ranking is unavailable. */
  private fun importanceOf(sbn: StatusBarNotification): Int? {
    return try {
      val ranking = NotificationListenerService.Ranking()
      if (currentRanking?.getRanking(sbn.key, ranking) == true) ranking.importance else null
    } catch (e: Exception) {
      Log.w("CrustNotificationListener", "could not read ranking importance", e)
      null
    }
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
    Log.d("CrustNotificationListener", "NotificationListenerService disconnected")
    if (NotificationListener.isListenerEnabled(applicationContext)) {
      runCatching {
        requestRebind(ComponentName(this, NotificationListenerServiceImpl::class.java))
      }.onFailure {
        Log.w("CrustNotificationListener", "Could not request notification-listener rebind", it)
      }
    }
  }

  override fun onDestroy() {
    super.onDestroy()
    Log.d("CrustNotificationListener", "NotificationListenerService being destroyed")
    NotificationListener.destroyInstance()
  }
}
