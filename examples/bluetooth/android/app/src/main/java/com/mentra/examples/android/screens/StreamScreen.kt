package com.mentra.examples.android.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mentra.examples.android.MentraExampleController
import com.mentra.examples.android.streamProtocolLabel
import com.mentra.examples.android.elapsedText
import com.mentra.examples.android.ui.AppColor
import com.mentra.examples.android.ui.GlassCard
import com.mentra.examples.android.ui.OfflineNotice
import com.mentra.examples.android.ui.PageHeader
import com.mentra.examples.android.ui.StatusBarRow

private val barHeights = listOf(18, 32, 48, 24, 40, 56, 30, 44, 22, 36, 50, 28, 40)
private val streamSdkCall = """
val streamId = "android-${'$'}{System.currentTimeMillis()}"
sdk.startStream(
  MentraStreamRequest(
    mapOf(
      "type" to "start_stream",
      "streamUrl" to streamUrl,
      "streamId" to streamId,
      "protocol" to streamProtocol,
      "keepAlive" to true,
      "keepAliveIntervalSeconds" to 15,
    )
  )
)
""".trimIndent()

@Composable
fun StreamScreen(controller: MentraExampleController) {
    val state = controller.state
    val connected = state.glassesStatus["connected"] == true
    val isLive = state.streamStartedAt != null
    val uptime = elapsedText(state.streamStartedAt)
    val setupHint = localStreamSetupHint(state.streamProtocol, state.streamUrl, state.streamStatus)
    val clipboardManager = LocalClipboardManager.current
    Column(modifier = Modifier.fillMaxSize().background(AppColor.bg).verticalScroll(rememberScrollState())) {
        StatusBarRow()
        PageHeader("Stream", connected)
        if (!connected) {
            OfflineNotice(modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
        }

        // Live preview card
        GlassCard(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            padding = PaddingValues(horizontal = 8.dp, vertical = 8.dp)
        ) {
            Box(
                modifier = Modifier.fillMaxWidth().height(160.dp).clip(RoundedCornerShape(22.dp))
                    .background(Brush.linearGradient(listOf(Color(0xFF163A26), Color(0xFF26583E), Color(0xFF7DD89E), Color(0xFF3F8F5C))))
            ) {
                // LIVE pill
                Row(
                    modifier = Modifier.align(Alignment.TopStart).padding(14.dp)
                        .clip(RoundedCornerShape(999.dp))
                        .background(Color.Black.copy(alpha = 0.45f))
                        .border(1.dp, Color.White.copy(alpha = 0.18f), RoundedCornerShape(999.dp))
                        .padding(horizontal = 11.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    Box(modifier = Modifier.size(7.dp).clip(CircleShape).background(if (isLive) AppColor.redLive else AppColor.greenSoft))
                    Text(if (isLive) "LIVE" else "READY", color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.8.sp)
                }
                Text(uptime, color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.align(Alignment.TopEnd).padding(14.dp))

                Row(
                    modifier = Modifier.align(Alignment.Center).padding(top = 0.dp),
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                    verticalAlignment = Alignment.Bottom
                ) {
                    barHeights.forEachIndexed { i, h ->
                        Box(modifier = Modifier.size(width = 5.dp, height = h.dp).clip(RoundedCornerShape(3.dp)).background(if (i % 3 == 2) Color.White else Color.White.copy(alpha = 0.85f)))
                    }
                }
                Text(
                    if (isLive) "${state.streamProtocol.uppercase()} · keep-alive 15s" else "Ready · enter stream URL",
                    color = Color.White.copy(alpha = 0.85f),
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Medium,
                    modifier = Modifier.align(Alignment.BottomStart).padding(14.dp)
                )
            }

            Spacer(Modifier.height(14.dp))
            Box(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp)
                    .clip(RoundedCornerShape(18.dp))
                    .background(Brush.verticalGradient(if (isLive) listOf(Color(0xFFFF6B5B), AppColor.red) else listOf(Color(0xFF26473A), Color(0xFF1F3A2A))))
                    .clickable(enabled = connected || isLive) { controller.toggleStream() }
                    .padding(vertical = 16.dp),
                contentAlignment = Alignment.Center
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Box(modifier = Modifier.size(12.dp).clip(RoundedCornerShape(3.dp)).background(Color.White))
                    Text(if (!connected && !isLive) "Connect glasses first" else if (isLive) "End stream" else "Start stream", color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }

        // SDK card
        Column(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)
                .clip(RoundedCornerShape(22.dp))
                .border(1.dp, AppColor.borderSoft, RoundedCornerShape(22.dp))
        ) {
            Column(modifier = Modifier.fillMaxWidth().background(AppColor.ink).padding(horizontal = 16.dp, vertical = 14.dp)) {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text("SDK CALL", color = AppColor.greenAccent, fontSize = 9.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.1.sp)
                    Row(
                        modifier = Modifier
                            .clip(RoundedCornerShape(6.dp))
                            .background(Color.White.copy(alpha = 0.06f))
                            .clickable { clipboardManager.setText(AnnotatedString(streamSdkCall)) }
                            .padding(horizontal = 8.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp)
                    ) {
                        Icon(Icons.Outlined.ContentCopy, null, tint = AppColor.consoleText, modifier = Modifier.size(10.dp))
                        Text("Copy", color = AppColor.consoleText, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
                Spacer(Modifier.height(8.dp))
                Text(
                    streamSdkCall,
                    color = AppColor.consoleText, fontSize = 11.sp, fontFamily = FontFamily.Monospace
                )
            }
            Row(
                modifier = Modifier.fillMaxWidth().background(Color.White.copy(alpha = 0.6f)).padding(horizontal = 16.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                Box(modifier = Modifier.size(22.dp).clip(CircleShape).background(AppColor.red.copy(alpha = 0.16f)), contentAlignment = Alignment.Center) {
                    Box(modifier = Modifier.size(8.dp).clip(CircleShape).background(AppColor.red))
                }
                Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                    Text(state.streamStatus, color = AppColor.ink, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                    Text("uptime $uptime · keep-alive 15s", color = AppColor.muted, fontSize = 10.sp, fontWeight = FontWeight.Medium)
                }
                Text("Stats →", color = AppColor.muted, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
            }
        }

        // Protocol card
        GlassCard(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            corner = 22,
            padding = PaddingValues(horizontal = 14.dp, vertical = 14.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(AppColor.ink.copy(alpha = 0.05f)).padding(4.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                ProtocolTab("RTMP", state.streamProtocol == "rtmp", Modifier.weight(1f)) { controller.selectProtocol("rtmp") }
                ProtocolTab("SRT", state.streamProtocol == "srt", Modifier.weight(1f)) { controller.selectProtocol("srt") }
                ProtocolTab("WebRTC", state.streamProtocol == "webrtc", Modifier.weight(1f)) { controller.selectProtocol("webrtc") }
            }
            Spacer(Modifier.height(12.dp))
            Row(
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(AppColor.ink.copy(alpha = 0.04f)).padding(horizontal = 14.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                Text(streamProtocolLabel(state.streamProtocol), color = AppColor.greenAccent, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.5.sp)
                Box(modifier = Modifier.size(width = 1.dp, height = 14.dp).background(AppColor.ink.copy(alpha = 0.12f)))
                BasicTextField(
                    value = state.streamUrl,
                    onValueChange = controller::setStreamUrl,
                    singleLine = true,
                    textStyle = androidx.compose.ui.text.TextStyle(color = AppColor.ink, fontSize = 13.sp, fontWeight = FontWeight.Medium),
                    modifier = Modifier.weight(1f),
                )
                Icon(Icons.Outlined.Edit, null, tint = AppColor.muted, modifier = Modifier.size(14.dp))
            }
            if (setupHint != null) {
                Spacer(Modifier.height(12.dp))
                Text(
                    setupHint,
                    color = AppColor.muted,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Medium,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(12.dp))
                        .background(AppColor.ink.copy(alpha = 0.04f))
                        .padding(horizontal = 12.dp, vertical = 10.dp)
                )
            }
        }

        Spacer(Modifier.height(140.dp))
    }
}

private fun localStreamSetupHint(protocol: String, streamUrl: String, status: String): String? {
    if (protocol != "rtmp" && protocol != "webrtc") {
        return null
    }
    val normalized = status.lowercase()
    val url = streamUrl.trim()
    val needsSetup = url.isEmpty() ||
        url.contains("<computer-ip>") ||
        url.contains("YOUR_") ||
        normalized.contains("not reachable") ||
        normalized.contains("replace") ||
        normalized.contains("required")
    if (!needsSetup) {
        return null
    }
    if (protocol == "rtmp") {
        return "Local RTMP setup: run python3 examples/local-demo-cloud/server.py, paste the printed RTMP publish URL here, then open the printed HLS preview URL on your computer. The printed ffplay command is optional for debugging."
    }
    return "Local WebRTC setup: run python3 examples/local-demo-cloud/server.py, paste the printed WHIP publish URL here, then open the WebRTC preview URL on your computer."
}

@Composable
private fun ProtocolTab(title: String, active: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(10.dp))
            .background(if (active) Color.White else Color.Transparent)
            .clickable { onClick() }
            .padding(vertical = 10.dp, horizontal = 8.dp),
        contentAlignment = Alignment.Center
    ) {
        Text(title, color = if (active) AppColor.ink else AppColor.muted, fontSize = 12.sp, fontWeight = if (active) FontWeight.Bold else FontWeight.Medium)
    }
}
