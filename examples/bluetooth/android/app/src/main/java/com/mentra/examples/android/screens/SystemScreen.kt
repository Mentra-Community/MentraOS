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
import androidx.compose.runtime.LaunchedEffect
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mentra.examples.android.ExampleEvent
import com.mentra.examples.android.MentraExampleController
import com.mentra.examples.android.MentraExampleState
import com.mentra.examples.android.connectedWifiStatus
import com.mentra.examples.android.durationText
import com.mentra.examples.android.galleryHotspotPasswordLabel
import com.mentra.examples.android.galleryHotspotSsidLabel
import com.mentra.examples.android.galleryServerUrl
import com.mentra.examples.android.hotspotLabel
import com.mentra.examples.android.isGlassesConnected
import com.mentra.examples.android.rgbLedColorOptions
import com.mentra.examples.android.wifiLabel
import com.mentra.examples.android.wifiScanResults
import com.mentra.examples.android.ui.AppColor
import com.mentra.examples.android.ui.GlassCard
import com.mentra.examples.android.ui.OfflineNotice
import com.mentra.examples.android.ui.PageHeader
import com.mentra.examples.android.ui.scrollBottomPadding
import java.util.Locale

private const val WIFI_COLLAPSED_NETWORK_LIMIT = 3

@Composable
fun SystemScreen(controller: MentraExampleController) {
    val state = controller.state
    val connected = isGlassesConnected(state.glassesStatus)
    val currentWifi = connectedWifiStatus(state.glassesStatus)
    val currentWifiSsid = currentWifi?.ssid
    val networks = wifiScanResults(state.bluetoothStatus).filter { network ->
        !connected ||
            currentWifi == null ||
            network.ssid != currentWifiSsid
    }
    val inputChips = remember(state.events) { recentInputChips(state.events) }
    val galleryUrl = galleryServerUrl(state.glassesStatus, state.hotspotEnabled)
    val galleryHotspotPassword = galleryUrl?.let { galleryHotspotPasswordLabel(state.glassesStatus) }
    var pendingWifiSsid by remember { mutableStateOf<String?>(null) }
    var pendingWifiPassword by remember { mutableStateOf("") }
    var wifiExpanded by remember { mutableStateOf(false) }
    val visibleNetworks = if (wifiExpanded) networks else networks.take(WIFI_COLLAPSED_NETWORK_LIMIT)
    val hiddenNetworkCount = (networks.size - visibleNetworks.size).coerceAtLeast(0)
    val canToggleWifiList = networks.size > WIFI_COLLAPSED_NETWORK_LIMIT
    val micStatus = when {
        state.micRecording -> recordingMicStatus(state)
        state.micPlaying -> "playing last recording"
        state.lastMicDurationSeconds != null && state.lastMicBytes > 0 -> "last ${durationText(state.lastMicDurationSeconds)} · ${formatPcmBytes(state.lastMicBytes)}"
        connected -> "record PCM from glasses"
        else -> "connect glasses to record"
    }
    val canRecordMic = connected && !state.micPlaying
    val canPlayMic = state.lastMicBytes > 0 && !state.micRecording
    val phoneVolumeLabel = state.phoneMediaVolume?.let { volume ->
        state.phoneMediaVolumeMax?.let { max -> "$volume / $max" } ?: volume.toString()
    } ?: "unknown"
    val glassesVolumeLabel = state.glassesMediaVolume?.let { "$it / 15" } ?: "unknown"

    LaunchedEffect(connected) {
        if (connected) {
            controller.requestWifiScan()
        }
    }

    Column(modifier = Modifier.fillMaxSize().background(AppColor.bg).verticalScroll(rememberScrollState())) {
        PageHeader("System")
        if (!connected) {
            OfflineNotice(modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
        }

        // Wi-Fi card
        GlassCard(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            padding = PaddingValues(horizontal = 18.dp, vertical = 18.dp)
        ) {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Column {
                    Text("Wi-Fi", color = AppColor.ink, fontSize = 17.sp, fontWeight = FontWeight.Bold)
                    Text("${networks.size} networks nearby", color = AppColor.muted, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                }
                Row(
                    modifier = Modifier.clip(RoundedCornerShape(999.dp))
                        .background(if (connected) AppColor.ink.copy(alpha = 0.05f) else AppColor.red.copy(alpha = 0.08f))
                        .clickable(enabled = connected) { controller.requestWifiScan() }
                        .heightIn(min = 44.dp)
                        .padding(horizontal = 14.dp, vertical = 9.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    Icon(Icons.Outlined.Refresh, null, tint = if (connected) AppColor.ink else AppColor.red, modifier = Modifier.size(14.dp))
                    Text(if (connected) "Scan" else "Connect glasses", color = if (connected) AppColor.ink else AppColor.red, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                }
            }
            Spacer(Modifier.height(4.dp))
            if (!connected) {
                DisabledHint("Connect glasses first to scan or join Wi-Fi networks.")
                Spacer(Modifier.height(4.dp))
            }
            currentWifi?.let { wifi ->
                NetworkRow(
                    wifiLabel(state.glassesStatus),
                    wifi.localIp ?: "connected",
                    AppColor.greenAccent,
                    check = true,
                    actionLabel = "Forget",
                    actionColor = AppColor.red,
                    onActionClick = controller::forgetCurrentWifiNetwork,
                )
            }
            visibleNetworks.forEachIndexed { index, network ->
                val ssid = network.ssid.ifBlank { "Unknown" }
                val requiresPassword = network.requiresPassword
                val pending = state.wifiPendingSsid == ssid
                val joinNetwork: () -> Unit = {
                    if (requiresPassword) {
                        pendingWifiPassword = ""
                        pendingWifiSsid = ssid
                    } else {
                        controller.sendWifiCredentials(ssid, "", requiresPassword = false)
                    }
                }
                NetworkRow(
                    ssid,
                    if (pending) "connecting..." else "${if (requiresPassword) "secured" else "open"} · ${network.signalStrength}",
                    AppColor.muted,
                    faint = true,
                    locked = requiresPassword,
                    last = index == visibleNetworks.lastIndex && !canToggleWifiList,
                    actionLabel = "Join",
                    actionColor = AppColor.greenDeep,
                    onActionClick = joinNetwork,
                    onClick = joinNetwork,
                )
            }
            if (canToggleWifiList) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { wifiExpanded = !wifiExpanded }
                        .padding(top = 12.dp, bottom = 2.dp),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        if (wifiExpanded) "Show fewer networks" else "Show $hiddenNetworkCount more network${if (hiddenNetworkCount == 1) "" else "s"}",
                        color = AppColor.greenInk,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                    )
                    Spacer(Modifier.width(6.dp))
                    Icon(
                        if (wifiExpanded) Icons.Outlined.KeyboardArrowUp else Icons.Outlined.KeyboardArrowDown,
                        contentDescription = null,
                        tint = AppColor.greenInk,
                        modifier = Modifier.size(14.dp),
                    )
                }
            }
        }

        // Hotspot card
        Box(modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
            GlassCard(
                modifier = Modifier.fillMaxWidth(),
                corner = 22,
                padding = PaddingValues(horizontal = 16.dp, vertical = 14.dp)
            ) {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        IconTile(Icons.Outlined.WifiTethering)
                        Column {
                            Text("Hotspot", color = AppColor.ink, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                            Text(
                                if (connected) hotspotLabel(state.glassesStatus, state.hotspotEnabled) else "connect glasses to toggle",
                                color = if (state.hotspotEnabled) AppColor.greenAccent else AppColor.muted,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.Medium,
                            )
                        }
                    }
                    Box(
                        modifier = Modifier
                            .size(width = 48.dp, height = 44.dp)
                            .clickable(enabled = connected) { controller.toggleHotspot() },
                        contentAlignment = Alignment.Center
                    ) {
                        Box(
                            modifier = Modifier
                                .size(width = 44.dp, height = 26.dp)
                                .clip(RoundedCornerShape(999.dp))
                                .background(Color.White)
                                .border(
                                    1.2.dp,
                                    if (state.hotspotEnabled) AppColor.greenAccent.copy(alpha = 0.72f) else AppColor.ink.copy(alpha = 0.18f),
                                    RoundedCornerShape(999.dp)
                                )
                                .padding(horizontal = 3.dp),
                            contentAlignment = if (state.hotspotEnabled) Alignment.CenterEnd else Alignment.CenterStart
                        ) {
                            Box(modifier = Modifier.size(20.dp).clip(CircleShape).background(if (state.hotspotEnabled) AppColor.greenAccent else AppColor.mutedSoft))
                        }
                    }
                }
                Spacer(Modifier.height(12.dp))
                Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(AppColor.ink.copy(alpha = 0.05f)))
                Spacer(Modifier.height(10.dp))
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.Top) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text("Gallery server", color = AppColor.ink, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                        Text(
                            galleryUrl ?: "Enable hotspot to expose local gallery access",
                            color = if (galleryUrl != null) AppColor.greenAccent else AppColor.muted,
                            fontSize = 11.sp,
                            lineHeight = 15.sp,
                            fontWeight = FontWeight.Medium,
                        )
                        if (galleryHotspotPassword != null) {
                            Text(
                                "Join ${galleryHotspotSsidLabel(state.glassesStatus)} · password $galleryHotspotPassword",
                                color = AppColor.muted,
                                fontSize = 11.sp,
                                lineHeight = 15.sp,
                            )
                        }
                    }
                    Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            HotspotActionChip("Open", enabled = galleryUrl != null, onClick = controller::openGalleryServer)
                            HotspotActionChip("Wi-Fi", enabled = galleryUrl != null, onClick = controller::openWifiSettings)
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            HotspotActionChip("Copy URL", enabled = galleryUrl != null, onClick = controller::copyGalleryServerUrl)
                            HotspotActionChip("Copy pwd", enabled = galleryHotspotPassword != null, onClick = controller::copyGalleryHotspotPassword)
                        }
                    }
                }
                Spacer(Modifier.height(8.dp))
                Text(
                    state.galleryServerStatus,
                    color = when (state.galleryServerReachable) {
                        true -> AppColor.greenAccent
                        false -> AppColor.red
                        null -> AppColor.muted
                    },
                    fontSize = 12.sp,
                    lineHeight = 16.sp,
                    fontWeight = FontWeight.Medium,
                )
            }
        }

        // Microphone card
        GlassCard(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            corner = 22,
            padding = PaddingValues(horizontal = 16.dp, vertical = 16.dp)
        ) {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    IconTile(Icons.Outlined.Mic)
                    Column {
                        Text("Microphone", color = AppColor.ink, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                        Text(micStatus, color = if (state.micRecording || state.micPlaying) AppColor.greenAccent else AppColor.muted, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    MicControlButton(
                        icon = if (state.micRecording) Icons.Outlined.Stop else Icons.Filled.Circle,
                        enabled = canRecordMic,
                        active = state.micRecording,
                    ) { controller.toggleMic() }
                    MicControlButton(
                        icon = if (state.micPlaying) Icons.Outlined.Stop else Icons.Outlined.PlayArrow,
                        enabled = canPlayMic || state.micPlaying,
                        active = state.micPlaying,
                    ) { controller.playMicRecording() }
                }
            }
            Spacer(Modifier.height(12.dp))
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                Column(modifier = Modifier.weight(1f)) {
                    AudioStatusLine("Bond", state.audioBondStatus.removePrefix("Bond: "))
                    AudioStatusLine("A2DP", state.audioMediaStatus.removePrefix("Media: "), good = state.audioMediaConnected)
                    AudioStatusLine("Route", state.phoneAudioRoute)
                }
                Column(modifier = Modifier.weight(1f)) {
                    AudioStatusLine("Android vol", phoneVolumeLabel)
                    AudioStatusLine("SDK vol", glassesVolumeLabel, good = state.glassesMediaVolume != null)
                    Spacer(Modifier.height(6.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
                        MicControlButton(
                            icon = Icons.Outlined.Remove,
                            enabled = connected && state.glassesMediaVolume != null && state.glassesMediaVolume > 0,
                            active = false,
                        ) { controller.decreaseGlassesMediaVolume() }
                        MicControlButton(
                            icon = Icons.Outlined.Add,
                            enabled = connected && state.glassesMediaVolume != null && state.glassesMediaVolume < 15,
                            active = false,
                        ) { controller.increaseGlassesMediaVolume() }
                        TextButton(
                            onClick = controller::refreshGlassesMediaVolume,
                            enabled = connected,
                            modifier = Modifier.padding(top = 2.dp)
                        ) {
                            Text("Read")
                        }
                    }
                }
            }
            if (!connected) {
                Spacer(Modifier.height(10.dp))
                DisabledHint("Connect glasses before recording or playing microphone audio.")
            } else if (state.micPlaybackHint != null) {
                Spacer(Modifier.height(10.dp))
                Text(
                    state.micPlaybackHint,
                    color = AppColor.red,
                    fontSize = 12.sp,
                    lineHeight = 16.sp,
                )
            } else if (!state.audioMediaConnected) {
                Spacer(Modifier.height(10.dp))
                Text(
                    "Playback needs Bluetooth media connected. Android usually asks to pair after BLE connects; use Settings if it is not connected.",
                    color = AppColor.red,
                    fontSize = 12.sp,
                    lineHeight = 16.sp,
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(
                    onClick = controller::openBluetoothSettings,
                    modifier = Modifier.padding(top = 2.dp)
                ) {
                    Text("Bluetooth settings")
                }
                TextButton(
                    onClick = controller::refreshAudioRoute,
                    modifier = Modifier.padding(top = 2.dp)
                ) {
                    Text("Refresh route")
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
                        Text("button · touch · swipe", color = AppColor.muted, fontSize = 12.sp, fontWeight = FontWeight.Medium)
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
                    Text(if (connected) "LIVE" else "OFF", color = AppColor.greenDeep, fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.5.sp)
                }
            }
            Spacer(Modifier.height(10.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                inputChips.forEach { chip ->
                    InputChip(chip.age, chip.label, modifier = Modifier.weight(1f))
                }
            }
            if (!connected) {
                Spacer(Modifier.height(10.dp))
                DisabledHint("Connect glasses to receive button/touch events and change gallery mode.")
            }
            Spacer(Modifier.height(12.dp))
            Text("Save in gallery mode", color = AppColor.ink, fontSize = 14.sp, fontWeight = FontWeight.Bold)
            Text(
                if (state.galleryModeEnabled) {
                    "On: the glasses button saves photos/videos locally."
                } else {
                    "Off: button and touch events are reported to the phone."
                },
                color = AppColor.muted,
                fontSize = 12.sp,
                lineHeight = 16.sp,
            )
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                GalleryModeChip("Save media", state.galleryModeEnabled, connected) { controller.setGalleryModeEnabled(true) }
                GalleryModeChip("Report events", !state.galleryModeEnabled, connected) { controller.setGalleryModeEnabled(false) }
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
                "Mentra Live RGB controls demonstrate LED color and timing patterns.",
                color = AppColor.muted,
                fontSize = 11.sp,
                lineHeight = 16.sp,
                fontWeight = FontWeight.Medium,
            )
            if (!connected) {
                Spacer(Modifier.height(10.dp))
                DisabledHint("Connect glasses to send RGB LED commands.")
            }
        }

        Spacer(Modifier.height(scrollBottomPadding()))
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
        modifier = Modifier.size(44.dp)
            .clip(CircleShape)
            .background(if (active) AppColor.greenInk else Color.White)
            .clickable(enabled = enabled) { onClick() },
        contentAlignment = Alignment.Center
    ) {
        Icon(
            icon,
            null,
            tint = if (active) Color.White else AppColor.greenInk.copy(alpha = if (enabled) 1f else 0.38f),
            modifier = Modifier.size(16.dp)
        )
    }
}

@Composable
private fun AudioStatusLine(label: String, value: String, good: Boolean? = null) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(top = 2.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label.uppercase(), color = AppColor.muted, fontSize = 9.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.6.sp)
        Text(
            value,
            modifier = Modifier.weight(1f).padding(start = 8.dp),
            color = when (good) {
                true -> AppColor.greenAccent
                false -> AppColor.red
                null -> AppColor.ink
            },
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
            maxLines = 2,
            textAlign = TextAlign.End,
        )
    }
}

@Composable
private fun DisabledHint(message: String) {
    Text(
        message,
        color = AppColor.red,
        fontSize = 12.sp,
        lineHeight = 16.sp,
        fontWeight = FontWeight.Medium,
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(AppColor.red.copy(alpha = 0.08f))
            .padding(horizontal = 10.dp, vertical = 8.dp),
    )
}

@Composable
private fun HotspotActionChip(label: String, enabled: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (enabled) AppColor.greenInk else AppColor.muted,
        fontSize = 12.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(if (enabled) AppColor.greenAccent.copy(alpha = 0.14f) else AppColor.ink.copy(alpha = 0.04f))
            .clickable(enabled = enabled) { onClick() }
            .widthIn(min = 72.dp)
            .heightIn(min = 40.dp)
            .padding(horizontal = 11.dp, vertical = 8.dp),
    )
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
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(enabled = onClick != null) { onClick?.invoke() }.padding(vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Box(modifier = Modifier.size(28.dp), contentAlignment = Alignment.Center) {
                Icon(Icons.Outlined.Wifi, null, tint = if (faint) AppColor.mutedSoft else AppColor.greenInk, modifier = Modifier.size(20.dp))
            }
            Column(modifier = Modifier.weight(1f)) {
                Text(name, color = AppColor.ink, fontSize = 15.sp, fontWeight = FontWeight.Bold)
                Text(sub, color = subColor, fontSize = 12.sp, fontWeight = FontWeight.Medium)
            }
            if (rssi != null) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(rssi, color = AppColor.ink, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                    if (check) Icon(Icons.Filled.Check, null, tint = AppColor.ink, modifier = Modifier.size(14.dp))
                }
            }
            if (actionLabel != null) {
                Text(
                    actionLabel,
                    color = actionColor,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier
                        .clip(RoundedCornerShape(999.dp))
                        .background(actionColor.copy(alpha = 0.10f))
                        .clickable(enabled = onActionClick != null) { onActionClick?.invoke() }
                        .widthIn(min = 64.dp)
                        .heightIn(min = 40.dp)
                        .padding(horizontal = 12.dp, vertical = 8.dp)
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
        fontSize = 13.sp,
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
            .heightIn(min = 44.dp)
            .padding(horizontal = 14.dp, vertical = 10.dp)
    )
}

private data class InputChipModel(
    val age: String,
    val label: String,
)

private fun recordingMicStatus(state: MentraExampleState): String {
    if (state.pcmBytes <= 0) {
        return "recording · listening for speech"
    }
    return "recording · ${formatPcmBytes(state.pcmBytes)} captured"
}

private fun formatPcmBytes(bytes: Int): String {
    if (bytes < 1024) {
        return "$bytes B PCM"
    }
    val kib = bytes / 1024.0
    if (kib < 1024) {
        val value = String.format(Locale.US, if (kib >= 10) "%.0f" else "%.1f", kib)
        return "$value KB PCM"
    }
    val mib = kib / 1024.0
    val value = String.format(Locale.US, if (mib >= 10) "%.0f" else "%.1f", mib)
    return "$value MB PCM"
}

private fun recentInputChips(events: List<ExampleEvent>): List<InputChipModel> {
    val labels = events.mapNotNull { inputLabel(it.text) }.take(3)
    if (labels.isEmpty()) {
        return listOf(InputChipModel("--", "waiting"))
    }
    return labels.mapIndexed { index, label ->
        InputChipModel("${index + 1}s", label)
    }
}

private fun inputLabel(text: String): String? {
    val normalized = normalizeInputText(text)
    val prefix = normalized.substringBefore(" ")
    if (prefix !in inputEventPrefixes) {
        return null
    }
    val payload = normalized.removePrefix(prefix).trim()
    return beautifyInputPayload(payload).ifBlank { prefix }
}

private val inputEventPrefixes = setOf("button", "touch", "swipe")

private val inputLabelReplacements = listOf(
    "forward swipe" to "swipe →",
    "right swipe" to "swipe →",
    "backward swipe" to "swipe ←",
    "backwards swipe" to "swipe ←",
    "left swipe" to "swipe ←",
    "up swipe" to "swipe ↑",
    "down swipe" to "swipe ↓",
    "single tap" to "tap",
    "long press" to "long",
)

private fun normalizeInputText(text: String): String =
    text
        .trim()
        .lowercase()
        .replace("->", " forward swipe ")
        .replace(Regex("[_:]+"), " ")
        .replace(Regex("\\s+"), " ")
        .trim()

private fun beautifyInputPayload(payload: String): String {
    var label = payload
    inputLabelReplacements.forEach { (source, replacement) ->
        label = label.replace(source, replacement)
    }
    return label
}

@Composable
private fun InputChip(prefix: String, label: String, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .clip(RoundedCornerShape(12.dp))
            .background(AppColor.ink.copy(alpha = 0.04f))
            .heightIn(min = 40.dp)
            .padding(horizontal = 10.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Text(prefix, color = AppColor.muted, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
        Text(
            label,
            color = AppColor.ink,
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun LedTab(icon: ImageVector, label: String, active: Boolean, modifier: Modifier, enabled: Boolean = true, onClick: () -> Unit) {
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(10.dp))
            .background(if (active) Color.White else Color.Transparent)
            .clickable(enabled = enabled) { onClick() }
            .heightIn(min = 44.dp)
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
            .heightIn(min = 40.dp)
            .padding(horizontal = 8.dp, vertical = 9.dp),
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
            fontSize = 11.sp,
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
