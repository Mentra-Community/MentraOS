package com.mentra.examples.android.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.Icon
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mentra.examples.android.MentraExampleController
import com.mentra.examples.android.durationText
import com.mentra.examples.android.hotspotLabel
import com.mentra.examples.android.isGlassesConnected
import com.mentra.examples.android.rgbLedColorOptions
import com.mentra.examples.android.wifiLabel
import com.mentra.examples.android.wifiScanResults
import com.mentra.examples.android.ui.AppColor
import com.mentra.examples.android.ui.GlassCard
import com.mentra.examples.android.ui.OfflineNotice
import com.mentra.examples.android.ui.PageHeader

@Composable
fun SystemScreen(controller: MentraExampleController) {
    val state = controller.state
    val connected = isGlassesConnected(state.glassesStatus)
    val networks = wifiScanResults(state.bluetoothStatus)
    val inputEvents = state.events.filter { it.text.contains("button") || it.text.contains("touch") || it.text.contains("swipe") }.take(3)
    var pendingWifiSsid by remember { mutableStateOf<String?>(null) }
    var pendingWifiPassword by remember { mutableStateOf("") }
    val micStatus = when {
        state.micRecording -> "recording ${durationText(state.micElapsedSeconds)} · ${state.pcmFrames} PCM frames"
        state.micPlaying -> "playing last recording"
        state.lastMicDurationSeconds != null && state.lastMicBytes > 0 -> "last ${durationText(state.lastMicDurationSeconds)} · ${state.lastMicBytes} PCM bytes"
        connected -> "record PCM from glasses"
        else -> "connect glasses to record"
    }
    Column(modifier = Modifier.fillMaxSize().background(AppColor.bg).verticalScroll(rememberScrollState())) {
        PageHeader("System", connected)
        if (!connected) {
            OfflineNotice(modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
        }

        // Wi-Fi card
        GlassCard(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            padding = PaddingValues(horizontal = 18.dp, vertical = 18.dp)
        ) {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    IconTile(Icons.Outlined.Wifi, big = true)
                    Column {
                        Text("Wi-Fi", color = AppColor.ink, fontSize = 17.sp, fontWeight = FontWeight.Bold)
                        Text("${networks.size} networks nearby", color = AppColor.muted, fontSize = 10.sp, fontWeight = FontWeight.Medium)
                    }
                }
                Row(
                    modifier = Modifier.clip(RoundedCornerShape(999.dp)).background(AppColor.ink.copy(alpha = 0.05f))
                        .clickable(enabled = connected) { controller.requestWifiScan() }
                        .padding(horizontal = 12.dp, vertical = 7.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    Icon(Icons.Outlined.Refresh, null, tint = AppColor.ink, modifier = Modifier.size(11.dp))
                    Text("Scan", color = AppColor.ink, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                }
            }
            Spacer(Modifier.height(4.dp))
            val currentWifiConnected = state.glassesStatus["wifiConnected"] == true
            NetworkRow(
                wifiLabel(state.glassesStatus),
                (state.glassesStatus["wifiLocalIp"] as? String) ?: "not connected",
                if (currentWifiConnected) AppColor.greenAccent else AppColor.muted,
                check = currentWifiConnected,
                actionLabel = if (currentWifiConnected) "Forget" else null,
                actionColor = AppColor.red,
                onActionClick = if (currentWifiConnected) controller::forgetCurrentWifiNetwork else null,
            )
            val rows = if (networks.isEmpty()) listOf(mapOf("ssid" to "Scan for nearby networks", "requiresPassword" to false, "signalStrength" to 0)) else networks
            rows.forEachIndexed { index, network ->
                val ssid = network["ssid"] as? String ?: "Unknown"
                val requiresPassword = network["requiresPassword"] as? Boolean ?: false
                val pending = state.wifiPendingSsid == ssid
                val joinNetwork: () -> Unit = {
                    if (ssid != "Scan for nearby networks") {
                        if (requiresPassword) {
                            pendingWifiPassword = ""
                            pendingWifiSsid = ssid
                        } else {
                            controller.sendWifiCredentials(ssid, "", requiresPassword = false)
                        }
                    }
                }
                NetworkRow(
                    ssid,
                    if (pending) "connecting..." else "${if (requiresPassword) "secured" else "open"} · ${network["signalStrength"] ?: 0}",
                    AppColor.muted,
                    faint = true,
                    locked = requiresPassword,
                    last = index == rows.lastIndex,
                    actionLabel = if (ssid == "Scan for nearby networks") null else "Join",
                    actionColor = AppColor.greenDeep,
                    onActionClick = if (ssid == "Scan for nearby networks") null else joinNetwork,
                    onClick = joinNetwork,
                )
            }
        }

        // Hotspot + Mic
        Row(modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(modifier = Modifier.weight(1f).clickable(enabled = connected) { controller.toggleHotspot() }) {
            GlassCard(
                modifier = Modifier.fillMaxWidth(),
                corner = 22,
                padding = PaddingValues(horizontal = 16.dp, vertical = 16.dp)
            ) {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    IconTile(Icons.Outlined.WifiTethering)
                    Box(
                        modifier = Modifier.size(width = 38.dp, height = 22.dp).clip(RoundedCornerShape(999.dp)).background(Color.White).padding(2.dp),
                        contentAlignment = Alignment.CenterEnd
                    ) {
                        Box(modifier = Modifier.size(18.dp).clip(CircleShape).background(if (state.hotspotEnabled) AppColor.greenAccent else AppColor.mutedSoft))
                    }
                }
                Spacer(Modifier.height(10.dp))
                Text("Hotspot", color = AppColor.ink, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                Text(hotspotLabel(state.glassesStatus, state.hotspotEnabled), color = if (state.hotspotEnabled) AppColor.greenAccent else AppColor.muted, fontSize = 10.sp, fontWeight = FontWeight.Medium)
            }
            }
            Box(modifier = Modifier.weight(1f)) {
            GlassCard(
                modifier = Modifier.fillMaxWidth(),
                corner = 22,
                padding = PaddingValues(horizontal = 16.dp, vertical = 16.dp)
            ) {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    IconTile(Icons.Outlined.Mic)
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        MicControlButton(
                            icon = if (state.micRecording) Icons.Outlined.Stop else Icons.Filled.Circle,
                            enabled = connected,
                            active = state.micRecording,
                        ) { controller.toggleMic() }
                        MicControlButton(
                            icon = if (state.micPlaying) Icons.Outlined.Stop else Icons.Outlined.PlayArrow,
                            enabled = state.lastMicBytes > 0,
                            active = state.micPlaying,
                        ) { controller.playMicRecording() }
                    }
                }
                Spacer(Modifier.height(10.dp))
                Text("Microphone", color = AppColor.ink, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                Text(micStatus, color = if (state.micRecording || state.micPlaying) AppColor.greenAccent else AppColor.muted, fontSize = 10.sp, fontWeight = FontWeight.Medium)
            }
            }
        }

        // Inputs card
        GlassCard(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            corner = 22,
            padding = PaddingValues(horizontal = 18.dp, vertical = 16.dp)
        ) {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    IconTile(Icons.Outlined.RadioButtonChecked)
                    Column {
                        Text("Inputs", color = AppColor.ink, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                        Text("button · touch · swipe", color = AppColor.muted, fontSize = 10.sp, fontWeight = FontWeight.Medium)
                    }
                }
                Row(
                    modifier = Modifier.clip(RoundedCornerShape(999.dp)).background(AppColor.greenAccent.copy(alpha = 0.16f))
                        .border(1.dp, AppColor.greenAccent.copy(alpha = 0.3f), RoundedCornerShape(999.dp))
                        .padding(horizontal = 9.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(5.dp)
                ) {
                    Box(modifier = Modifier.size(5.dp).clip(CircleShape).background(if (connected) AppColor.greenAccent else AppColor.mutedSoft))
                    Text(if (connected) "LIVE" else "OFF", color = AppColor.greenDeep, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.5.sp)
                }
            }
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                val chips = if (inputEvents.isEmpty()) listOf("waiting for input") else inputEvents.map { it.text }
                chips.forEachIndexed { index, text ->
                    InputChip("${index + 1}s", text)
                }
            }
            Spacer(Modifier.height(12.dp))
            Text("Save in gallery mode", color = AppColor.ink, fontSize = 14.sp, fontWeight = FontWeight.Bold)
            Text(
                if (state.galleryModeAuto) {
                    "On: the glasses button saves photos/videos locally."
                } else {
                    "Off: button and touch events are reported to the phone."
                },
                color = AppColor.muted,
                fontSize = 11.sp,
                lineHeight = 15.sp,
            )
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                GalleryModeChip("Save media", state.galleryModeAuto, connected) { controller.setGalleryModeAuto(true) }
                GalleryModeChip("Report events", !state.galleryModeAuto, connected) { controller.setGalleryModeAuto(false) }
            }
        }

        // RGB LED card
        GlassCard(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
            corner = 24
        ) {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Column {
                    Text("RGB LED", color = AppColor.ink, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                    Text("color & pattern", color = AppColor.muted, fontSize = 11.sp)
                }
                Row(
                    modifier = Modifier.clip(RoundedCornerShape(999.dp)).background(AppColor.ink.copy(alpha = 0.06f)).padding(horizontal = 11.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    if (state.ledMode != "Off") {
                        Box(modifier = Modifier.size(8.dp).clip(CircleShape).background(ledSwatchColor(state.ledColor)))
                    }
                    Text(if (state.ledMode == "Off") "off" else "on", color = AppColor.ink, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                }
            }
            Spacer(Modifier.height(14.dp))
            Row(
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(AppColor.ink.copy(alpha = 0.05f)).padding(4.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                LedTab(Icons.Outlined.DoNotDisturb, "Off", state.ledMode == "Off", Modifier.weight(1f), enabled = connected) { controller.selectLedMode("Off") }
                LedTab(Icons.Filled.Circle, "Solid", state.ledMode == "Solid", Modifier.weight(1f), enabled = connected) { controller.selectLedMode("Solid") }
                LedTab(Icons.Outlined.GpsFixed, "Pulse", state.ledMode == "Pulse", Modifier.weight(1f), enabled = connected) { controller.selectLedMode("Pulse") }
                LedTab(Icons.Outlined.RadioButtonUnchecked, "Blink", state.ledMode == "Blink", Modifier.weight(1f), enabled = connected) { controller.selectLedMode("Blink") }
            }
            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
                rgbLedColorOptions.forEach { color ->
                    LedColorChip(
                        colorName = color,
                        active = state.ledColor == color,
                        enabled = connected,
                        modifier = Modifier.weight(1f),
                    ) { controller.selectLedColor(color) }
                }
            }
            Spacer(Modifier.height(14.dp))
            Text(
                "Mentra Live currently applies RGB color and pattern; visible brightness is firmware-controlled.",
                color = AppColor.muted,
                fontSize = 11.sp,
                lineHeight = 16.sp,
                fontWeight = FontWeight.Medium,
            )
        }

        Spacer(Modifier.height(140.dp))
    }

    val pendingSsid = pendingWifiSsid
    if (pendingSsid != null) {
        AlertDialog(
            onDismissRequest = {
                pendingWifiSsid = null
                pendingWifiPassword = ""
            },
            title = { Text("Join Wi-Fi") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(pendingSsid, color = AppColor.muted)
                    OutlinedTextField(
                        value = pendingWifiPassword,
                        onValueChange = { pendingWifiPassword = it },
                        label = { Text("Password") },
                        singleLine = true,
                    )
                }
            },
            confirmButton = {
                Button(
                    enabled = pendingWifiPassword.isNotBlank(),
                    onClick = {
                        controller.sendWifiCredentials(pendingSsid, pendingWifiPassword, requiresPassword = true)
                        pendingWifiSsid = null
                        pendingWifiPassword = ""
                    }
                ) {
                    Text("Connect")
                }
            },
            dismissButton = {
                TextButton(
                    onClick = {
                        pendingWifiSsid = null
                        pendingWifiPassword = ""
                    }
                ) {
                    Text("Cancel")
                }
            }
        )
    }
}

@Composable
private fun IconTile(icon: ImageVector, big: Boolean = false) {
    val size = if (big) 36.dp else 32.dp
    val corner = if (big) 12.dp else 10.dp
    Box(
        modifier = Modifier.size(size)
            .clip(RoundedCornerShape(corner))
            .background(AppColor.greenSoft.copy(alpha = 0.18f))
            .border(1.dp, AppColor.greenAccent.copy(alpha = 0.22f), RoundedCornerShape(corner)),
        contentAlignment = Alignment.Center
    ) {
        Icon(icon, null, tint = AppColor.greenInk, modifier = Modifier.size(if (big) 18.dp else 16.dp))
    }
}

@Composable
private fun MicControlButton(icon: ImageVector, enabled: Boolean, active: Boolean, onClick: () -> Unit) {
    Box(
        modifier = Modifier.size(28.dp)
            .clip(CircleShape)
            .background(if (active) AppColor.greenInk else Color.White)
            .clickable(enabled = enabled) { onClick() },
        contentAlignment = Alignment.Center
    ) {
        Icon(
            icon,
            null,
            tint = if (active) Color.White else AppColor.greenInk.copy(alpha = if (enabled) 1f else 0.38f),
            modifier = Modifier.size(13.dp)
        )
    }
}

@Composable
private fun NetworkRow(
    name: String,
    sub: String,
    subColor: Color,
    rssi: String? = null,
    check: Boolean = false,
    faint: Boolean = false,
    locked: Boolean = false,
    last: Boolean = false,
    actionLabel: String? = null,
    actionColor: Color = AppColor.ink,
    onActionClick: (() -> Unit)? = null,
    onClick: (() -> Unit)? = null,
) {
    Column {
        Row(
            modifier = Modifier.fillMaxWidth().clickable(enabled = onClick != null) { onClick?.invoke() }.padding(vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Box(modifier = Modifier.size(28.dp), contentAlignment = Alignment.Center) {
                Icon(Icons.Outlined.Wifi, null, tint = if (faint) AppColor.mutedSoft else AppColor.greenInk, modifier = Modifier.size(20.dp))
            }
            Column(modifier = Modifier.weight(1f)) {
                Text(name, color = AppColor.ink, fontSize = 15.sp, fontWeight = FontWeight.Bold)
                Text(sub, color = subColor, fontSize = 11.sp, fontWeight = FontWeight.Medium)
            }
            if (rssi != null) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(rssi, color = AppColor.ink, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                    if (check) Icon(Icons.Filled.Check, null, tint = AppColor.ink, modifier = Modifier.size(14.dp))
                }
            }
            if (actionLabel != null) {
                Text(
                    actionLabel,
                    color = actionColor,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier
                        .clip(RoundedCornerShape(999.dp))
                        .background(actionColor.copy(alpha = 0.10f))
                        .clickable(enabled = onActionClick != null) { onActionClick?.invoke() }
                        .padding(horizontal = 10.dp, vertical = 6.dp)
                )
            }
            if (locked) Icon(Icons.Outlined.Lock, null, tint = AppColor.ink, modifier = Modifier.size(14.dp))
        }
        if (!last) Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(AppColor.ink.copy(alpha = 0.04f)))
    }
}

@Composable
private fun GalleryModeChip(label: String, active: Boolean, enabled: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) AppColor.greenInk else AppColor.muted,
        fontSize = 12.sp,
        fontWeight = if (active) FontWeight.Bold else FontWeight.Medium,
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(if (active) AppColor.greenAccent.copy(alpha = 0.16f) else AppColor.ink.copy(alpha = 0.04f))
            .border(
                1.dp,
                if (active) AppColor.greenAccent.copy(alpha = 0.32f) else AppColor.ink.copy(alpha = 0.05f),
                RoundedCornerShape(999.dp)
            )
            .clickable(enabled = enabled) { onClick() }
            .padding(horizontal = 12.dp, vertical = 8.dp)
    )
}

@Composable
private fun InputChip(prefix: String, label: String) {
    Row(
        modifier = Modifier.clip(RoundedCornerShape(10.dp)).background(AppColor.ink.copy(alpha = 0.04f)).padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp)
    ) {
        Text(prefix, color = AppColor.muted, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
        Text(label, color = AppColor.ink, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun LedTab(icon: ImageVector, label: String, active: Boolean, modifier: Modifier, enabled: Boolean = true, onClick: () -> Unit) {
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(10.dp))
            .background(if (active) Color.White else Color.Transparent)
            .clickable(enabled = enabled) { onClick() }
            .padding(vertical = 10.dp, horizontal = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Icon(icon, null, tint = if (active) AppColor.ink else AppColor.muted, modifier = Modifier.size(16.dp))
        Text(label, color = if (active) AppColor.ink else AppColor.muted, fontSize = 12.sp, fontWeight = if (active) FontWeight.SemiBold else FontWeight.Medium)
    }
}

@Composable
private fun LedColorChip(colorName: String, active: Boolean, enabled: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Row(
        modifier = modifier
            .clip(RoundedCornerShape(999.dp))
            .background(if (active) Color.White else AppColor.ink.copy(alpha = 0.04f))
            .border(1.dp, ledChipBorderColor(colorName, active), RoundedCornerShape(999.dp))
            .clickable(enabled = enabled) { onClick() }
            .padding(horizontal = 8.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp)
    ) {
        Box(
            modifier = Modifier.size(9.dp)
                .clip(CircleShape)
                .background(ledSwatchColor(colorName))
                .border(1.dp, AppColor.ink.copy(alpha = if (colorName == "white") 0.16f else 0f), CircleShape)
        )
        Text(
            colorName.replaceFirstChar { it.uppercase() },
            color = if (active) AppColor.ink else AppColor.muted,
            fontSize = 10.sp,
            fontWeight = if (active) FontWeight.SemiBold else FontWeight.Medium,
            maxLines = 1,
        )
    }
}

private fun ledChipBorderColor(colorName: String, active: Boolean): Color {
    if (!active) {
        return AppColor.ink.copy(alpha = 0.05f)
    }
    if (colorName == "white") {
        return AppColor.ink.copy(alpha = 0.16f)
    }
    return ledSwatchColor(colorName).copy(alpha = 0.42f)
}

private fun ledSwatchColor(colorName: String): Color {
    return when (colorName) {
        "red" -> AppColor.red
        "blue" -> AppColor.ble
        "orange" -> AppColor.amber
        "white" -> Color.White
        else -> AppColor.greenAccent
    }
}
