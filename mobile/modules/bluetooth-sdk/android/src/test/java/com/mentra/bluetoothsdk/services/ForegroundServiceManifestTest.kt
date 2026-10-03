package com.mentra.bluetoothsdk.services

import android.Manifest
import android.content.ComponentName
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.LocationManager
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class ForegroundServiceManifestTest {
    @Test
    fun `host manifest controls startup and resume even with all permissions granted`() {
        val application = RuntimeEnvironment.getApplication()
        val component = ComponentName(application, ForegroundService::class.java)
        val info = application.packageManager.getServiceInfo(component, 0)
        ReflectionHelpers.setField(info, "mForegroundServiceType", ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        shadowOf(application.packageManager).addOrUpdateService(info)
        shadowOf(application).grantPermissions(
            Manifest.permission.BLUETOOTH_CONNECT,
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.ACCESS_FINE_LOCATION,
        )
        shadowOf(application.getSystemService(LocationManager::class.java)).setLocationEnabled(true)

        val controller = Robolectric.buildService(ForegroundService::class.java).create()
        val service = controller.get()
        try {
            assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE, service.foregroundServiceType)
            service.onStartCommand(Intent(ForegroundService.ACTION_REFRESH_TYPES), 0, 1)
            assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE, service.foregroundServiceType)
            service.onStartCommand(null, 0, 2)
            assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE, service.foregroundServiceType)
        } finally {
            controller.destroy()
        }
    }

    @Test
    fun `default library manifest retains the MentraOS startup type`() {
        val controller = Robolectric.buildService(ForegroundService::class.java).create()
        try {
            assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC, controller.get().foregroundServiceType)
        } finally {
            controller.destroy()
        }
    }
}
