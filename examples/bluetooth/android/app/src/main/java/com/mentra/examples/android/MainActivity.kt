package com.mentra.examples.android

import android.Manifest
import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.mentra.bluetoothsdk.MentraBluetoothError
import com.mentra.bluetoothsdk.MentraBluetoothSdk
import com.mentra.bluetoothsdk.MentraBluetoothSdkListener
import com.mentra.bluetoothsdk.MentraBluetoothStatusUpdate
import com.mentra.bluetoothsdk.MentraDashboardPositionRequest
import com.mentra.bluetoothsdk.MentraDeviceModel
import com.mentra.bluetoothsdk.MentraDiscoveredDevice
import com.mentra.bluetoothsdk.MentraDisplayTextRequest
import com.mentra.bluetoothsdk.MentraGlassesStatusUpdate

class MainActivity : Activity(), MentraBluetoothSdkListener {
    private lateinit var sdk: MentraBluetoothSdk
    private lateinit var statusText: TextView
    private lateinit var logText: TextView
    private var latestDevice: MentraDiscoveredDevice? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        sdk = MentraBluetoothSdk.create(applicationContext, listener = this)
        setContentView(createContentView())
        requestRuntimePermissions()
        appendLog("SDK ready. Start a scan to find Mentra Live glasses.")
    }

    override fun onDestroy() {
        sdk.close()
        super.onDestroy()
    }

    private fun createContentView(): LinearLayout {
        statusText = TextView(this).apply {
            textSize = 18f
            text = "Not connected"
        }
        logText = TextView(this).apply {
            textSize = 14f
        }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 32, 32, 32)
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
        }

        root.addView(statusText)
        root.addView(button("Scan for Mentra Live") {
            latestDevice = null
            sdk.startScan(MentraDeviceModel.MENTRA_LIVE)
            appendLog("Scanning for Mentra Live glasses...")
        })
        root.addView(button("Connect first/default") {
            val device = latestDevice
            if (device != null) {
                sdk.connect(device)
                appendLog("Connecting to ${device.name}...")
            } else {
                sdk.connectDefault()
                appendLog("No scan result yet. Trying default device...")
            }
        })
        root.addView(button("Display hello") {
            sdk.displayText(
                MentraDisplayTextRequest(
                    text = "Hello from bare Android",
                    x = 0,
                    y = 0,
                    size = 24,
                )
            )
            appendLog("Sent display text.")
        })
        root.addView(button("Apply display settings") {
            sdk.setBrightness(level = 60)
            sdk.setDashboardPosition(MentraDashboardPositionRequest(height = 4, depth = 6))
            appendLog("Applied brightness and dashboard position.")
        })
        root.addView(button("Clear display") {
            sdk.clearDisplay()
            appendLog("Cleared display.")
        })
        root.addView(button("Disconnect") {
            sdk.disconnect()
            appendLog("Disconnect requested.")
        })
        root.addView(ScrollView(this).apply {
            addView(logText)
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f,
            )
        })

        return root
    }

    private fun button(label: String, onClick: () -> Unit): Button =
        Button(this).apply {
            text = label
            setOnClickListener { onClick() }
        }

    private fun requestRuntimePermissions() {
        val permissions = buildList {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                add(Manifest.permission.BLUETOOTH_SCAN)
                add(Manifest.permission.BLUETOOTH_CONNECT)
            } else {
                add(Manifest.permission.ACCESS_FINE_LOCATION)
            }
            add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= 33) {
                add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }.toTypedArray()

        requestPermissions(permissions, 42)
    }

    override fun onDeviceDiscovered(device: MentraDiscoveredDevice) {
        latestDevice = device
        appendLog("Discovered ${device.name}")
    }

    override fun onGlassesStatusChanged(status: MentraGlassesStatusUpdate) {
        runOnUiThread {
            statusText.text = "Glasses: $status"
        }
    }

    override fun onBluetoothStatusChanged(status: MentraBluetoothStatusUpdate) {
        appendLog("Bluetooth status: $status")
    }

    override fun onLog(message: String) {
        appendLog(message)
    }

    override fun onError(error: MentraBluetoothError) {
        appendLog("Error: $error")
    }

    private fun appendLog(message: String) {
        runOnUiThread {
            logText.append("\n$message")
        }
    }
}
