package com.mentra.examples.android.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mentra.core.DeviceModel
import com.mentra.core.GlassesStatus
import com.mentra.examples.android.MentraExampleController
import com.mentra.examples.android.R
import com.mentra.examples.android.batteryLabel
import com.mentra.examples.android.batteryLevel
import com.mentra.examples.android.bluetoothSearchLabel
import com.mentra.examples.android.canConnectTarget
import com.mentra.examples.android.connectionLabel
import com.mentra.examples.android.connectionTargetLabel
import com.mentra.examples.android.connectedWifiStatus
import com.mentra.examples.android.deviceModelLabel
import com.mentra.examples.android.deviceLabel
import com.mentra.examples.android.discoveredDeviceKey
import com.mentra.examples.android.firmwareLabel
import com.mentra.examples.android.firmwareSubLabel
import com.mentra.examples.android.hasSavedConnectionTarget
import com.mentra.examples.android.isGlassesConnected
import com.mentra.examples.android.modelLabel
import com.mentra.examples.android.rssiLabel
import com.mentra.examples.android.rssiUpdatedLabel
import com.mentra.examples.android.savedConnectionTargetDetail
import com.mentra.examples.android.savedConnectionTargetName
import com.mentra.examples.android.scanModelOptions
import com.mentra.examples.android.supportsDisplay
import com.mentra.examples.android.targetDeviceDetail
import com.mentra.examples.android.wifiLabel
import com.mentra.examples.android.ui.AppColor
import com.mentra.examples.android.ui.Eyebrow
import com.mentra.examples.android.ui.GlassCard
import com.mentra.examples.android.ui.PageHeader
import com.mentra.examples.android.ui.scrollBottomPadding

@Composable
fun DeviceScreen(controller: MentraExampleController) {
    val state = controller.state
    val glasses = state.glassesStatus
    val connected = isGlassesConnected(glasses)
    val canConnect = !connected && canConnectTarget(state)
    val hasDefaultTarget = hasSavedConnectionTarget(state.bluetoothStatus)
    val displaySupported = connected && supportsDisplay(glasses)
    val currentDeviceName = if (connected) connectionTargetLabel(state, glasses) else deviceLabel(glasses)
    val level = batteryLevel(glasses)
    val latestEvent = state.events.firstOrNull()
    val currentWifi = connectedWifiStatus(glasses)
    Column(
        modifier = Modifier.fillMaxSize().background(AppColor.bg).verticalScroll(rememberScrollState())
    ) {
        PageHeader("Device", connected)

        // Hero card
        GlassCard(modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
            Row(verticalAlignment = Alignment.Top) {
                Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Eyebrow(connectionLabel(glasses), color = AppColor.greenAccent)
                    Text(modelLabel(glasses), color = AppColor.ink, fontSize = 28.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = (-0.7).sp)
                    Text(currentDeviceName, color = AppColor.muted, fontSize = 11.sp, fontWeight = FontWeight.Medium)
                }
                Image(
                    painter = painterResource(id = glassesImageRes(glasses)),
                    contentDescription = "Connected glasses preview",
                    modifier = Modifier.size(width = 145.dp, height = 52.dp),
                    contentScale = ContentScale.Fit
                )
            }
            Spacer(Modifier.height(14.dp))
            Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(AppColor.hairline))
            Spacer(Modifier.height(12.dp))
            Row(verticalAlignment = Alignment.Bottom) {
                Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Eyebrow("BATTERY")
                    Row(verticalAlignment = Alignment.Bottom) {
                        Text(level?.toString() ?: "--", color = AppColor.ink, fontSize = 56.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = (-2.2).sp)
                        Spacer(Modifier.width(6.dp))
                        Text("%", color = AppColor.muted, fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
                    }
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Icon(Icons.Filled.Bolt, contentDescription = null, tint = AppColor.greenAccent, modifier = Modifier.size(11.dp))
                        Text(if (glasses?.charging == true) "Charging" else "Waiting", color = AppColor.greenAccent, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.Bottom) {
                    val heights = listOf(14, 22, 30, 38, 46, 54, 62)
                    heights.forEachIndexed { i, h ->
                        Box(modifier = Modifier.size(width = 6.dp, height = h.dp).clip(RoundedCornerShape(3.dp)).background(if (level != null && i < kotlin.math.ceil(level / 100f * 7).toInt()) AppColor.greenAccent else Color(0x0F000000)))
                    }
                }
            }
        }

        // Stat row
        Row(modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            StatTile("FIRMWARE", firmwareLabel(glasses), firmwareSubLabel(glasses), AppColor.greenAccent, Modifier.weight(1f))
            StatTile("WI-FI", wifiLabel(glasses), currentWifi?.localIp ?: "unknown", AppColor.muted, Modifier.weight(1f), bold = true)
            StatTile("RSSI", rssiLabel(glasses), rssiUpdatedLabel(glasses), AppColor.greenAccent, Modifier.weight(1f), bold = true)
        }

        // Quick actions
        GlassCard(modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("Quick actions", color = AppColor.inkAlt, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                Eyebrow("SDK", color = AppColor.inkAlt.copy(alpha = 0.4f), mono = true)
            }
            Spacer(Modifier.height(16.dp))
            ScanModelPicker(controller, connected)
            Spacer(Modifier.height(12.dp))
            TargetPicker(controller, connected, glasses)
            Spacer(Modifier.height(12.dp))
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    DarkBtn("Scan", Icons.Outlined.Search, AppColor.greenInk, Modifier.weight(1f), enabled = !connected, onClick = controller::startScan)
                    DarkBtn(if (connected) "Connected" else "Connect", Icons.Outlined.Link, AppColor.greenPrimary, Modifier.weight(1f), enabled = canConnect, onClick = controller::connect)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    LightBtn("Display Hello", Icons.Outlined.Tv, Modifier.weight(1f), enabled = displaySupported, onClick = controller::displayHello)
                    LightBtn("Clear Display", Icons.Outlined.Tv, Modifier.weight(1f), enabled = displaySupported, onClick = controller::clearDisplay)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    LightBtn("Clear Default", Icons.Outlined.DeleteOutline, Modifier.weight(1f), enabled = hasDefaultTarget, onClick = controller::clearDefaultDevice)
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .clip(RoundedCornerShape(18.dp))
                            .background(
                                Brush.verticalGradient(
                                    listOf(
                                        Color(0xFFDE3A30).copy(alpha = if (connected) 1f else 0.45f),
                                        Color(0xFFC43B30).copy(alpha = if (connected) 1f else 0.45f),
                                    )
                                )
                            )
                            .clickable(enabled = connected) { controller.disconnect() }
                            .padding(vertical = 14.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Icon(Icons.Outlined.LinkOff, null, tint = Color.White, modifier = Modifier.size(14.dp))
                            Text("Disconnect", color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
                if (connected && !displaySupported) {
                    Text(
                        "${modelLabel(glasses)} has no display, so display commands are disabled.",
                        color = AppColor.muted,
                        fontSize = 11.sp,
                        lineHeight = 15.sp,
                        fontWeight = FontWeight.Medium,
                    )
                }
            }
        }

        // Live status
        GlassCard(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            padding = PaddingValues(top = 22.dp, bottom = 22.dp, start = 0.dp, end = 0.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(modifier = Modifier.size(7.dp).clip(CircleShape).background(AppColor.greenPrimary))
                    Text("Live status", color = AppColor.inkAlt, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                }
                Box(modifier = Modifier.clip(RoundedCornerShape(999.dp)).background(AppColor.greenInk.copy(alpha = 0.06f)).padding(horizontal = 10.dp, vertical = 4.dp)) {
                    Eyebrow("REC", color = AppColor.greenInk, mono = true)
                }
            }
            Spacer(Modifier.height(16.dp))
            Column(modifier = Modifier.padding(horizontal = 18.dp)) {
                StatusKVRow("LAST ACTION", value = state.lastAction, first = true)
                StatusKVRow("CONNECTION") {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Box(modifier = Modifier.size(6.dp).clip(CircleShape).background(AppColor.greenPrimary))
                        Text(connectionLabel(glasses), color = AppColor.greenInk, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
                StatusKVRow("DEVICE", value = currentDeviceName, mono = true)
                StatusKVRow("BATTERY") {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(batteryLabel(glasses), color = AppColor.inkAlt, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                        Row(
                            modifier = Modifier.clip(RoundedCornerShape(999.dp)).background(AppColor.greenPrimary.copy(alpha = 0.08f)).padding(horizontal = 8.dp, vertical = 2.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(4.dp)
                        ) {
                            Icon(Icons.Filled.Bolt, null, tint = AppColor.greenPrimary, modifier = Modifier.size(10.dp))
                            Text("charging", color = AppColor.greenPrimary, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
                StatusKVRow("BLUETOOTH", value = bluetoothSearchLabel(state.bluetoothStatus))
                StatusKVRow("TARGET", value = connectionTargetLabel(state, glasses), mono = true)
                StatusKVRow("DISCOVERED", value = state.discoveredDevices.joinToString { it.name }.ifBlank { "None yet" }, mono = true)
                StatusKVRow("PERMISSIONS", value = "Android runtime")
                StatusKVRow("CAMERA", value = state.cameraStatus)
                StatusKVRow("LATEST EVENT") {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Row(
                                modifier = Modifier.clip(RoundedCornerShape(5.dp)).background(AppColor.greenPrimary.copy(alpha = 0.08f)).padding(horizontal = 7.dp, vertical = 2.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(4.dp)
                            ) {
                                Box(modifier = Modifier.size(5.dp).clip(CircleShape).background(AppColor.greenPrimary))
                                Text(latestEvent?.tag ?: "NONE", color = AppColor.greenPrimary, fontSize = 10.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.6.sp)
                            }
                            Text(latestEvent?.time ?: "--:--:--", color = AppColor.inkAlt.copy(alpha = 0.65f), fontSize = 11.sp)
                        }
                        Text(latestEvent?.text ?: "No events yet", color = AppColor.inkAlt, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                    }
                }
            }
        }

        Spacer(Modifier.height(scrollBottomPadding()))
    }
}

private fun glassesImageRes(values: GlassesStatus?): Int {
    val model = listOfNotNull(
        values?.deviceModel,
        values?.bluetoothName,
    ).joinToString(" ").lowercase()

    return when {
        "even" in model && "g2" in model -> R.drawable.even_realities_g2
        "even" in model || "g1" in model -> R.drawable.even_realities_g1
        "display" in model -> R.drawable.mentra_display
        "vuzix" in model || "z100" in model -> R.drawable.vuzix_z100
        "unknown" in model -> R.drawable.unknown_wearable
        else -> R.drawable.mentra_live
    }
}

@Composable
private fun ScanModelPicker(controller: MentraExampleController, connected: Boolean) {
    val selectedModel = controller.state.selectedScanModel
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Eyebrow("SCAN MODEL", color = AppColor.muted, mono = true)
            if (connected) {
                Text("Disconnect to change", color = AppColor.muted, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            scanModelOptions.forEach { model ->
                ScanModelChip(
                    model = model,
                    active = selectedModel == model,
                    enabled = !connected,
                    modifier = Modifier.weight(1f),
                    onClick = { controller.selectScanModel(model) },
                )
            }
        }
    }
}

@Composable
private fun ScanModelChip(
    model: DeviceModel,
    active: Boolean,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val alpha = if (enabled) 1f else 0.45f
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(999.dp))
            .background(if (active) AppColor.greenPrimary.copy(alpha = 0.10f * alpha) else Color.White.copy(alpha = 0.72f * alpha))
            .border(
                1.dp,
                if (active) AppColor.greenPrimary.copy(alpha = 0.32f * alpha) else AppColor.hairline,
                RoundedCornerShape(999.dp),
            )
            .clickable(enabled = enabled) { onClick() }
            .padding(horizontal = 12.dp, vertical = 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            deviceModelLabel(model),
            color = if (active) AppColor.greenInk else AppColor.muted,
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
        )
    }
}

@Composable
private fun TargetPicker(controller: MentraExampleController, connected: Boolean, glasses: GlassesStatus?) {
    val state = controller.state
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(AppColor.ink.copy(alpha = 0.035f))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Eyebrow(if (connected) "CONNECTED DEVICE" else "CONNECTION TARGET", color = AppColor.inkAlt.copy(alpha = 0.45f), mono = true)
            if (!connected && state.discoveredDevices.isNotEmpty()) {
                Text(
                    if (state.selectedDiscoveredDevice == null) "choose one" else "${state.discoveredDevices.size} found",
                    color = AppColor.greenInk,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }

        when {
            connected -> TargetDeviceRow(
                name = deviceLabel(glasses),
                detail = "Active BLE connection",
                selected = true,
                enabled = false,
                onClick = {},
            )
            state.discoveredDevices.isEmpty() && hasSavedConnectionTarget(state.bluetoothStatus) -> TargetDeviceRow(
                name = savedConnectionTargetName(state.bluetoothStatus),
                detail = savedConnectionTargetDetail(state.bluetoothStatus),
                selected = true,
                enabled = false,
                onClick = {},
            )
            state.discoveredDevices.isEmpty() -> TargetDeviceRow(
                name = "Scan required",
                detail = "No saved default target yet. Scan to choose nearby glasses.",
                selected = false,
                enabled = false,
                onClick = {},
            )
            else -> state.discoveredDevices.forEach { device ->
                TargetDeviceRow(
                    name = device.name,
                    detail = targetDeviceDetail(device),
                    selected = state.selectedDiscoveredDevice?.let { discoveredDeviceKey(it) == discoveredDeviceKey(device) } == true,
                    enabled = true,
                    onClick = { controller.selectDiscoveredDevice(device) },
                )
            }
        }
    }
}

@Composable
private fun TargetDeviceRow(
    name: String,
    detail: String,
    selected: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(if (selected) AppColor.greenPrimary.copy(alpha = 0.08f) else Color.White.copy(alpha = 0.7f))
            .border(
                1.dp,
                if (selected) AppColor.greenPrimary.copy(alpha = 0.18f) else Color.White.copy(alpha = 0.7f),
                RoundedCornerShape(14.dp),
            )
            .clickable(enabled = enabled) { onClick() }
            .padding(horizontal = 10.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Box(
            modifier = Modifier
                .size(18.dp)
                .clip(CircleShape)
                .background(if (selected) AppColor.greenPrimary else Color.White)
                .border(1.dp, AppColor.borderSoft, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            if (selected) {
                Icon(Icons.Outlined.Check, null, tint = Color.White, modifier = Modifier.size(12.dp))
            }
        }
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(name, color = AppColor.inkAlt, fontSize = 13.sp, fontWeight = FontWeight.Bold)
            Text(detail, color = AppColor.muted, fontSize = 10.sp, fontWeight = FontWeight.Medium)
        }
    }
}

@Composable
private fun StatTile(label: String, value: String, sub: String, subColor: Color, modifier: Modifier, bold: Boolean = false) {
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(18.dp))
            .background(Color.White)
            .border(1.dp, AppColor.borderSoft, RoundedCornerShape(18.dp))
            .padding(horizontal = 14.dp, vertical = 13.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        Eyebrow(label)
        Text(value, color = AppColor.ink, fontSize = 14.sp, fontWeight = if (bold) FontWeight.Bold else FontWeight.SemiBold)
        Text(sub, color = subColor, fontSize = 11.sp, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun DarkBtn(title: String, icon: ImageVector, bg: Color, modifier: Modifier, enabled: Boolean = true, onClick: () -> Unit) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(14.dp))
            .background(bg.copy(alpha = if (enabled) 1f else 0.45f))
            .clickable(enabled = enabled) { onClick() }
            .padding(vertical = 14.dp),
        contentAlignment = Alignment.Center
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(icon, null, tint = Color.White, modifier = Modifier.size(14.dp))
            Text(title, color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun LightBtn(title: String, icon: ImageVector, modifier: Modifier, enabled: Boolean = true, onClick: () -> Unit) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(14.dp))
            .background(Color.White.copy(alpha = if (enabled) 1f else 0.45f))
            .border(1.dp, Color(0xFFDBDBDB), RoundedCornerShape(14.dp))
            .clickable(enabled = enabled) { onClick() }
            .padding(vertical = 14.dp),
        contentAlignment = Alignment.Center
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(icon, null, tint = AppColor.inkAlt.copy(alpha = if (enabled) 1f else 0.45f), modifier = Modifier.size(14.dp))
            Text(title, color = AppColor.inkAlt.copy(alpha = if (enabled) 1f else 0.45f), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun StatusKVRow(label: String, value: String? = null, mono: Boolean = false, first: Boolean = false, content: (@Composable () -> Unit)? = null) {
    Column {
        if (!first) {
            Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(Color(0xFFF2EDE0)))
        }
        Row(
            modifier = Modifier.fillMaxWidth().padding(vertical = 11.dp),
            verticalAlignment = Alignment.Top,
            horizontalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            Text(
                label,
                color = AppColor.inkAlt.copy(alpha = 0.5f),
                fontSize = 10.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 1.4.sp,
                modifier = Modifier.width(90.dp)
            )
            Box(modifier = Modifier.weight(1f)) {
                if (content != null) content()
                else if (value != null) {
                    Text(
                        value,
                        color = AppColor.inkAlt,
                        fontSize = if (mono) 12.sp else 13.sp,
                        fontWeight = FontWeight.Medium
                    )
                }
            }
        }
    }
}
