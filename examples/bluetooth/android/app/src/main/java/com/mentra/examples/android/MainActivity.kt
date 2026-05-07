package com.mentra.examples.android

import android.Manifest
import android.os.Bundle
import android.os.Build
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.core.app.ActivityCompat
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import com.mentra.examples.android.screens.CameraScreen
import com.mentra.examples.android.screens.ConsoleScreen
import com.mentra.examples.android.screens.DeviceScreen
import com.mentra.examples.android.screens.StreamScreen
import com.mentra.examples.android.screens.SystemScreen
import com.mentra.examples.android.ui.Tab
import com.mentra.examples.android.ui.TabBar
import com.mentra.examples.android.ui.LocalKeyboardVisible

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING)
        requestRuntimePermissions()
        setContent {
            MaterialTheme {
                var tab by remember { mutableStateOf(Tab.DEVICE) }
                val keyboardVisible = WindowInsets.ime.getBottom(LocalDensity.current) > 0
                val controller = remember { MentraExampleController(applicationContext) }
                DisposableEffect(controller) {
                    onDispose { controller.close() }
                }
                CompositionLocalProvider(LocalKeyboardVisible provides keyboardVisible) {
                    Box(modifier = Modifier.fillMaxSize().background(Color.White)) {
                        when (tab) {
                            Tab.DEVICE -> DeviceScreen(controller)
                            Tab.CAMERA -> CameraScreen(controller)
                            Tab.STREAM -> StreamScreen(controller)
                            Tab.SYSTEM -> SystemScreen(controller)
                            Tab.CONSOLE -> ConsoleScreen(controller)
                        }
                        if (!keyboardVisible) {
                            TabBar(
                                active = tab,
                                onChange = { tab = it },
                                modifier = Modifier
                                    .align(Alignment.BottomCenter)
                                    .padding(start = 12.dp, end = 12.dp, bottom = 10.dp)
                            )
                        }
                    }
                }
            }
        }
    }

    private fun requestRuntimePermissions() {
        val permissions = buildList {
            add(Manifest.permission.CAMERA)
            add(Manifest.permission.RECORD_AUDIO)
            add(Manifest.permission.ACCESS_FINE_LOCATION)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                add(Manifest.permission.BLUETOOTH_SCAN)
                add(Manifest.permission.BLUETOOTH_CONNECT)
            }
            if (Build.VERSION.SDK_INT >= 33) {
                add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }.toTypedArray()
        ActivityCompat.requestPermissions(this, permissions, 100)
    }
}
