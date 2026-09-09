package com.mentra.crust.services

import android.app.Application
import android.content.ComponentName
import android.provider.Settings
import android.service.notification.NotificationListenerService
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE, shadows = [RebindRecorder::class])
class NotificationListenerConfigTest {
  private lateinit var context: Application

  @Before
  fun reset() {
    context = RuntimeEnvironment.getApplication()
    grantPermission(false)
    NotificationListener.setNotificationConfig(context, false, emptyList())
    RebindRecorder.requests.clear()
  }

  @Test
  fun startupRebindsOnlyThroughReceiverAndConfigUpdatesDoNotRebind() {
    grantPermission(true)
    context.packageManager.setComponentEnabledSetting(
      component(),
      android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
      android.content.pm.PackageManager.DONT_KILL_APP,
    )
    NotificationListener.setNotificationConfig(context, true, emptyList())
    assertTrue(RebindRecorder.requests.isEmpty())
    deliverLatestConfig(expectedRebind = true)
    assertEquals(1, RebindRecorder.requests.size)

    NotificationListener.setNotificationConfig(context, true, listOf("blocked.app"))
    deliverLatestConfig(expectedRebind = false)
    assertEquals(1, RebindRecorder.requests.size)
    assertEquals(setOf("blocked.app"), preferences().getStringSet("notifications_blocklist", emptySet()))
  }

  @Test
  fun permissionGrantCountsAsStartupRecovery() {
    NotificationListener.setNotificationConfig(context, true, emptyList())
    assertTrue(shadowOf(context).broadcastIntents.isEmpty())
    grantPermission(true)
    assertTrue(NotificationListener.refreshComponentForPermission(context))
    assertTrue(RebindRecorder.requests.isEmpty())
    deliverLatestConfig(expectedRebind = true)

    NotificationListener.setNotificationConfig(context, true, listOf("blocked.app"))
    deliverLatestConfig(expectedRebind = false)
    assertEquals(1, RebindRecorder.requests.size)
  }

  @Test
  fun deniedPermissionNeverStartsNotificationProcess() {
    NotificationListener.setNotificationConfig(context, true, emptyList())
    assertFalse(NotificationListener.refreshComponentForPermission(context))
    assertTrue(shadowOf(context).broadcastIntents.isEmpty())
    assertTrue(RebindRecorder.requests.isEmpty())
    assertEquals(
      android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
      context.packageManager.getComponentEnabledSetting(component()),
    )
  }

  @Test
  fun disablingAndReenablingAllowsAnotherBind() {
    grantPermission(true)
    NotificationListener.setNotificationConfig(context, true, emptyList())
    deliverLatestConfig(expectedRebind = true)
    NotificationListener.setNotificationConfig(context, false, emptyList())
    deliverLatestConfig(expectedRebind = false)
    NotificationListener.setNotificationConfig(context, true, emptyList())
    deliverLatestConfig(expectedRebind = true)
    assertEquals(2, RebindRecorder.requests.size)
  }

  @Test
  fun confirmedRegrantCanRecoverAgainInSameProcess() {
    grantPermission(true)
    NotificationListener.setNotificationConfig(context, true, emptyList())
    deliverLatestConfig(expectedRebind = true)
    // Access can be revoked and granted in Settings without a config update.
    NotificationListener.refreshComponentForPermission(context)
    deliverLatestConfig(expectedRebind = true)
    NotificationListener.setNotificationConfig(context, true, emptyList())
    deliverLatestConfig(expectedRebind = false)
    assertEquals(2, RebindRecorder.requests.size)
  }

  private fun grantPermission(granted: Boolean) {
    Settings.Secure.putString(
      context.contentResolver,
      "enabled_notification_listeners",
      if (granted) component().flattenToString() else "",
    )
  }

  private fun component() = ComponentName(context, NotificationListenerServiceImpl::class.java)

  private fun preferences() = context.getSharedPreferences("mentra_crust_notification_prefs", 0)

  private fun deliverLatestConfig(expectedRebind: Boolean) {
    val intent = shadowOf(context).broadcastIntents.last()
    val config = NotificationProcessBridge.readConfig(intent)
    assertEquals(expectedRebind, config.requestRebind)
    // Model :notif's independent preference cache rather than relying on the
    // value just written by the app process.
    preferences().edit().clear().commit()
    NotificationConfigReceiver().onReceive(context, intent)
    assertEquals(config.listenerEnabled, preferences().getBoolean("notification_listener_enabled", false))
  }
}

@Implements(NotificationListenerService::class)
class RebindRecorder {
  companion object {
    val requests = mutableListOf<ComponentName>()

    @JvmStatic
    @Implementation
    fun requestRebind(component: ComponentName) {
      // Receiver must have applied config before binding the service.
      val context = RuntimeEnvironment.getApplication() as Application
      val prefs = context.getSharedPreferences("mentra_crust_notification_prefs", 0)
      assertTrue(prefs.getBoolean("notification_listener_enabled", false))
      requests.add(component)
    }
  }
}
