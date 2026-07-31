package com.mentra.crust.services

import android.app.ActivityManager
import android.app.Application
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Process
import android.util.Log
import java.io.File

/**
 * Identifies the lightweight process used by NotificationListenerService.
 *
 * The host app's generated MainApplication calls this before initializing
 * React Native. Keep this object free of Expo/React dependencies so loading it
 * cannot recreate the cold-start work that the process split avoids.
 */
object NotificationProcess {
  const val SUFFIX = ":notif"

  @JvmStatic
  fun isCurrent(context: Context): Boolean = currentName(context).endsWith(SUFFIX)

  private fun currentName(context: Context): String {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      return Application.getProcessName()
    }

    val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
    activityManager
      ?.runningAppProcesses
      ?.firstOrNull { it.pid == Process.myPid() }
      ?.processName
      ?.let { return it }

    return runCatching {
      File("/proc/self/cmdline").inputStream().bufferedReader().use { it.readText().trimEnd('\u0000') }
    }.getOrDefault(context.packageName)
  }
}

/**
 * Signature-protected, process-safe handoff from the notification process to
 * the React Native process. The receiver is dynamic, so sending while the app
 * runtime is dead does not start the expensive main process.
 */
object NotificationProcessBridge {
  private const val TAG = "CrustNotificationBridge"
  private const val POSTED_SUFFIX = ".crust.PHONE_NOTIFICATION"
  private const val DISMISSED_SUFFIX = ".crust.PHONE_NOTIFICATION_DISMISSED"
  private const val CONFIG_SUFFIX = ".crust.NOTIFICATION_CONFIG"
  private const val PERMISSION_SUFFIX = ".permission.CRUST_NOTIFICATION_BRIDGE"

  private const val EXTRA_NOTIFICATION_ID = "notificationId"
  private const val EXTRA_NOTIFICATION_KEY = "notificationKey"
  private const val EXTRA_PACKAGE_NAME = "packageName"
  private const val EXTRA_APP = "app"
  private const val EXTRA_TITLE = "title"
  private const val EXTRA_CONTENT = "content"
  private const val EXTRA_PRIORITY = "priority"
  private const val EXTRA_TIMESTAMP = "timestamp"
  private const val EXTRA_LISTENER_ENABLED = "listenerEnabled"
  private const val EXTRA_BLOCKLIST = "blocklist"

  fun register(
    context: Context,
    onEvent: (String, Map<String, Any>) -> Unit,
  ): BroadcastReceiver {
    val applicationContext = context.applicationContext
    val receiver =
      object : BroadcastReceiver() {
        override fun onReceive(receiveContext: Context, intent: Intent) {
          when (intent.action) {
            postedAction(receiveContext) -> {
              onEvent(
                "phone_notification",
                mapOf(
                  EXTRA_NOTIFICATION_ID to intent.getStringExtra(EXTRA_NOTIFICATION_ID).orEmpty(),
                  EXTRA_APP to intent.getStringExtra(EXTRA_APP).orEmpty(),
                  EXTRA_TITLE to intent.getStringExtra(EXTRA_TITLE).orEmpty(),
                  EXTRA_CONTENT to intent.getStringExtra(EXTRA_CONTENT).orEmpty(),
                  EXTRA_PRIORITY to intent.getIntExtra(EXTRA_PRIORITY, 0),
                  EXTRA_TIMESTAMP to intent.getLongExtra(EXTRA_TIMESTAMP, 0L),
                  EXTRA_PACKAGE_NAME to intent.getStringExtra(EXTRA_PACKAGE_NAME).orEmpty(),
                ),
              )
            }
            dismissedAction(receiveContext) -> {
              onEvent(
                "phone_notification_dismissed",
                mapOf(
                  EXTRA_NOTIFICATION_ID to intent.getStringExtra(EXTRA_NOTIFICATION_ID).orEmpty(),
                  EXTRA_NOTIFICATION_KEY to intent.getStringExtra(EXTRA_NOTIFICATION_KEY).orEmpty(),
                  EXTRA_PACKAGE_NAME to intent.getStringExtra(EXTRA_PACKAGE_NAME).orEmpty(),
                ),
              )
            }
          }
        }
      }

    val filter =
      IntentFilter().apply {
        addAction(postedAction(applicationContext))
        addAction(dismissedAction(applicationContext))
      }
    val permission = bridgePermission(applicationContext)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      applicationContext.registerReceiver(
        receiver,
        filter,
        permission,
        null,
        Context.RECEIVER_NOT_EXPORTED,
      )
    } else {
      @Suppress("UnspecifiedRegisterReceiverFlag")
      applicationContext.registerReceiver(receiver, filter, permission, null)
    }
    return receiver
  }

  fun unregister(context: Context, receiver: BroadcastReceiver) {
    runCatching { context.applicationContext.unregisterReceiver(receiver) }
      .onFailure { Log.w(TAG, "Could not unregister notification bridge", it) }
  }

  fun emitPosted(
    context: Context,
    notificationKey: String,
    packageName: String,
    appName: String,
    title: String,
    text: String,
    timestamp: Long,
    priority: Int,
  ) {
    val intent =
      Intent(postedAction(context))
        .setPackage(context.packageName)
        .putExtra(EXTRA_NOTIFICATION_ID, "$packageName-$notificationKey")
        .putExtra(EXTRA_APP, appName)
        .putExtra(EXTRA_TITLE, title.ifEmpty { appName })
        .putExtra(EXTRA_CONTENT, text)
        .putExtra(EXTRA_PRIORITY, priority)
        .putExtra(EXTRA_TIMESTAMP, timestamp)
        .putExtra(EXTRA_PACKAGE_NAME, packageName)
    context.sendBroadcast(intent, bridgePermission(context))
  }

  fun emitDismissed(context: Context, notificationKey: String, packageName: String) {
    val intent =
      Intent(dismissedAction(context))
        .setPackage(context.packageName)
        .putExtra(EXTRA_NOTIFICATION_ID, "$packageName-$notificationKey")
        .putExtra(EXTRA_NOTIFICATION_KEY, notificationKey)
        .putExtra(EXTRA_PACKAGE_NAME, packageName)
    context.sendBroadcast(intent, bridgePermission(context))
  }

  fun sendConfig(
    context: Context,
    listenerEnabled: Boolean,
    blocklist: Set<String>,
  ) {
    val intent =
      Intent(configAction(context))
        .setComponent(ComponentName(context, NotificationConfigReceiver::class.java))
        .putExtra(EXTRA_LISTENER_ENABLED, listenerEnabled)
        .putStringArrayListExtra(EXTRA_BLOCKLIST, ArrayList(blocklist))
    context.sendBroadcast(intent, bridgePermission(context))
  }

  internal fun readConfig(intent: Intent): Pair<Boolean, Set<String>> {
    return Pair(
      intent.getBooleanExtra(EXTRA_LISTENER_ENABLED, false),
      intent.getStringArrayListExtra(EXTRA_BLOCKLIST)?.toSet() ?: emptySet(),
    )
  }

  internal fun isConfigAction(context: Context, intent: Intent): Boolean = intent.action == configAction(context)

  private fun postedAction(context: Context) = context.packageName + POSTED_SUFFIX

  private fun dismissedAction(context: Context) = context.packageName + DISMISSED_SUFFIX

  private fun configAction(context: Context) = context.packageName + CONFIG_SUFFIX

  private fun bridgePermission(context: Context) = context.packageName + PERMISSION_SUFFIX
}

/** Applies live config updates inside the isolated notification process. */
class NotificationConfigReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (!NotificationProcessBridge.isConfigAction(context, intent)) return
    val (listenerEnabled, blocklist) = NotificationProcessBridge.readConfig(intent)
    NotificationListener.applyConfigToExisting(listenerEnabled, blocklist)
  }
}
