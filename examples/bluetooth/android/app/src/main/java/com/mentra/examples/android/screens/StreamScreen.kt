package com.mentra.examples.android.screens

import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.Image
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
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mentra.examples.android.MentraExampleController
import com.mentra.examples.android.elapsedText
import com.mentra.examples.android.isGlassesConnected
import com.mentra.examples.android.isGlassesWifiConnected
import com.mentra.examples.android.rtmpHlsPreviewUrl
import com.mentra.examples.android.srtHlsPreviewUrl
import com.mentra.examples.android.streamProtocolLabel
import com.mentra.examples.android.webrtcPreviewUrl
import com.mentra.examples.android.ui.AppColor
import com.mentra.examples.android.ui.GlassCard
import com.mentra.examples.android.ui.LocalKeyboardBottomInset
import com.mentra.examples.android.ui.LocalKeyboardVisible
import com.mentra.examples.android.ui.OfflineNotice
import com.mentra.examples.android.ui.PageHeader
import com.mentra.examples.android.ui.scrollBottomPadding
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.delay

private val barHeights = listOf(18, 32, 48, 24, 40, 56, 30, 44, 22, 36, 50, 28, 40)
private val streamSdkCall = """
val streamId = "android-${'$'}{System.currentTimeMillis()}"
mentraBluetoothSdk.startStream(
  StreamRequest(
    streamUrl = streamUrl,
    streamId = streamId,
    keepAlive = true,
    keepAliveIntervalSeconds = 15,
  )
)
""".trimIndent()

@Composable
fun StreamScreen(controller: MentraExampleController) {
    val state = controller.state
    val connected = isGlassesConnected(state.glassesStatus)
    val glassesWifiConnected = isGlassesWifiConnected(state.glassesStatus)
    val streamActive = state.streamRequested || state.streamStartedAt != null
    val wifiRequired = connected && !glassesWifiConnected && !streamActive
    val previewReady = streamActive && state.streamPreviewReady
    val cloudServerEnabled = state.streamCloudServerEnabled
    val directPhoneWebRtc = !cloudServerEnabled
    val streamIndicatorColor = when {
        previewReady -> AppColor.greenAccent
        streamActive || state.directStreamReceiverRunning -> AppColor.red
        else -> AppColor.muted
    }
    val uptime = elapsedText(state.streamStartedAt)
    val setupHint = if (cloudServerEnabled) localStreamSetupHint(state.streamProtocol, state.streamUrl, state.streamStatus) else null
    val previewTarget = if (cloudServerEnabled && previewReady) streamPreviewTarget(state.streamProtocol, state.streamUrl) else null
    val clipboardManager = LocalClipboardManager.current
    val keyboardController = LocalSoftwareKeyboardController.current
    val streamUrlFocusRequester = remember { FocusRequester() }
    val scrollState = rememberScrollState()
    var streamUrlFocused by remember { mutableStateOf(false) }

    LaunchedEffect(streamUrlFocused) {
        if (streamUrlFocused) {
            repeat(4) {
                scrollState.animateScrollTo(scrollState.maxValue)
                delay(120)
            }
        }
    }

    Column(modifier = Modifier.fillMaxSize().background(AppColor.bg).verticalScroll(scrollState)) {
        PageHeader("Stream", connected)
        if (!connected) {
            OfflineNotice(modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
        } else if (wifiRequired) {
            OfflineNotice(
                message = "Connect the glasses to Wi-Fi from the System tab before streaming. Streams are published over the glasses network connection.",
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)
            )
        }

        // Live preview card
        GlassCard(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            padding = PaddingValues(horizontal = 8.dp, vertical = 8.dp)
        ) {
            Box(modifier = Modifier.fillMaxWidth().height(160.dp).clip(RoundedCornerShape(22.dp))) {
                if (directPhoneWebRtc) {
                    DirectPhoneStreamPreview(
                        frame = state.directStreamFrame,
                        message = if (streamActive) "Waiting for first frame" else null,
                        modifier = Modifier.matchParentSize()
                    )
                } else if (previewTarget != null) {
                    LiveStreamPreview(previewTarget, modifier = Modifier.matchParentSize())
                } else {
                    PlaceholderStreamPreview(
                        message = if (streamActive) "Starting stream...\nWaiting for preview" else null,
                        modifier = Modifier.matchParentSize()
                    )
                }

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
                    Box(modifier = Modifier.size(7.dp).clip(CircleShape).background(if (streamActive) AppColor.redLive else AppColor.greenSoft))
                    Text(if (previewReady) "LIVE" else if (streamActive) "STARTING" else "READY", color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.8.sp)
                }
                Text(uptime, color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.align(Alignment.TopEnd).padding(14.dp))

                Text(
                    if (directPhoneWebRtc && previewReady) {
                        "WebRTC · phone receiver · keep-alive 15s"
                    } else if (directPhoneWebRtc && streamActive) {
                        "Waiting for first frame"
                    } else if (previewReady) {
                        "${state.streamProtocol.uppercase()} · keep-alive 15s"
                    } else if (streamActive) {
                        "Waiting for preview"
                    } else if (directPhoneWebRtc) {
                        "Ready · phone receiver starts on stream"
                    } else {
                        "Ready · enter stream URL"
                    },
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
                    .background(Brush.verticalGradient(if (streamActive) listOf(Color(0xFFDE3A30), Color(0xFFC43B30)) else listOf(Color(0xFF26473A), Color(0xFF1F3A2A))))
                    .clickable(enabled = (connected && glassesWifiConnected) || streamActive) {
                        if (cloudServerEnabled && shouldFocusStreamUrlTemplate(state.streamUrl, streamActive)) {
                            streamUrlFocusRequester.requestFocus()
                            keyboardController?.show()
                        }
                        controller.toggleStream()
                    }
                    .padding(vertical = 16.dp),
                contentAlignment = Alignment.Center
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Box(modifier = Modifier.size(12.dp).clip(RoundedCornerShape(3.dp)).background(Color.White))
                    Text(
                        if (!connected && !streamActive) {
                            "Connect glasses first"
                        } else if (!glassesWifiConnected && !streamActive) {
                            "Connect glasses to Wi-Fi"
                        } else if (streamActive) {
                            "End stream"
                        } else {
                            "Start stream"
                        },
                        color = Color.White,
                        fontSize = 15.sp,
                        fontWeight = FontWeight.SemiBold
                    )
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
                Box(modifier = Modifier.size(22.dp).clip(CircleShape).background(streamIndicatorColor.copy(alpha = 0.16f)), contentAlignment = Alignment.Center) {
                    Box(modifier = Modifier.size(8.dp).clip(CircleShape).background(streamIndicatorColor))
                }
                Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                    Text(state.streamStatus, color = AppColor.ink, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                    Text("uptime $uptime · keep-alive 15s", color = AppColor.muted, fontSize = 10.sp, fontWeight = FontWeight.Medium)
                }
            }
        }

        // Protocol card
        GlassCard(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            corner = 22,
            padding = PaddingValues(horizontal = 14.dp, vertical = 14.dp)
        ) {
            CloudServerToggle(
                enabled = cloudServerEnabled,
                onEnabledChange = controller::setStreamCloudServerEnabled,
            )
            if (cloudServerEnabled) {
                Spacer(Modifier.height(12.dp))
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
                        modifier = Modifier
                            .weight(1f)
                            .focusRequester(streamUrlFocusRequester)
                            .onFocusChanged { focusState ->
                                streamUrlFocused = focusState.isFocused
                            },
                    )
                    Icon(Icons.Outlined.Edit, null, tint = AppColor.muted, modifier = Modifier.size(14.dp))
                }
            } else {
                Spacer(Modifier.height(12.dp))
                Row(
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(AppColor.ink.copy(alpha = 0.04f)).padding(horizontal = 14.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    Box(modifier = Modifier.size(7.dp).clip(CircleShape).background(if (state.directStreamReceiverRunning) AppColor.greenAccent else AppColor.muted))
                    Text(
                        if (state.directStreamReceiverRunning) "Phone receiver ready" else "Phone receiver starts on stream",
                        color = AppColor.ink,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Medium,
                        modifier = Modifier.weight(1f)
                    )
                }
            }
            if (cloudServerEnabled && setupHint != null) {
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

        Spacer(Modifier.height(if (streamUrlFocused) maxOf(scrollBottomPadding(), 340.dp) else scrollBottomPadding()))
    }
}

private fun shouldFocusStreamUrlTemplate(streamUrl: String, streamActive: Boolean): Boolean =
    !streamActive && streamUrl.contains("<computer-ip>")

private data class StreamPreviewTarget(
    val kind: StreamPreviewKind,
    val url: String,
)

private enum class StreamPreviewKind {
    Hls,
    Web,
}

private fun streamPreviewTarget(protocol: String, streamUrl: String): StreamPreviewTarget? {
    return try {
        when (protocol) {
            "rtmp" -> rtmpHlsPreviewUrl(streamUrl)?.let { StreamPreviewTarget(StreamPreviewKind.Hls, it) }
            "srt" -> srtHlsPreviewUrl(streamUrl)?.let { StreamPreviewTarget(StreamPreviewKind.Hls, it) }
            "webrtc" -> StreamPreviewTarget(StreamPreviewKind.Web, webrtcPreviewUrl(streamUrl))
            else -> null
        }
    } catch (_: Exception) {
        null
    }
}

@Composable
private fun PlaceholderStreamPreview(message: String? = null, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .background(Brush.linearGradient(listOf(Color(0xFF163A26), Color(0xFF26583E), Color(0xFF7DD89E), Color(0xFF3F8F5C))))
    ) {
        if (message != null) {
            Text(
                message,
                color = Color.White,
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
                lineHeight = 21.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.align(Alignment.Center)
            )
        } else {
            Row(
                modifier = Modifier.align(Alignment.Center),
                horizontalArrangement = Arrangement.spacedBy(5.dp),
                verticalAlignment = Alignment.Bottom
            ) {
                barHeights.forEachIndexed { i, h ->
                    Box(
                        modifier = Modifier
                            .size(width = 5.dp, height = h.dp)
                            .clip(RoundedCornerShape(3.dp))
                            .background(if (i % 3 == 2) Color.White else Color.White.copy(alpha = 0.85f))
                    )
                }
            }
        }
    }
}

@Composable
private fun DirectPhoneStreamPreview(frame: android.graphics.Bitmap?, message: String? = null, modifier: Modifier = Modifier) {
    Box(modifier = modifier.background(Color.Black)) {
        if (frame != null) {
            Image(
                bitmap = frame.asImageBitmap(),
                contentDescription = "Direct phone WebRTC preview",
                modifier = Modifier.fillMaxSize(),
                contentScale = ContentScale.Fit
            )
        } else if (message != null) {
            Text(
                message,
                color = Color.White,
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
                lineHeight = 21.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.align(Alignment.Center)
            )
        }
    }
}

@Composable
private fun LiveStreamPreview(target: StreamPreviewTarget, modifier: Modifier = Modifier) {
    when (target.kind) {
        StreamPreviewKind.Hls -> HlsStreamPreview(target.url, modifier)
        StreamPreviewKind.Web -> WebStreamPreview(target.url, modifier)
    }
}

@Composable
private fun HlsStreamPreview(url: String, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val player = remember(url) {
        ExoPlayer.Builder(context).build().apply {
            setMediaItem(
                MediaItem.Builder()
                    .setUri(url)
                    .setMimeType(MimeTypes.APPLICATION_M3U8)
                    .build()
            )
            volume = 0f
            playWhenReady = true
            prepare()
        }
    }
    DisposableEffect(player) {
        onDispose { player.release() }
    }
    AndroidView(
        modifier = modifier.background(Color.Black),
        factory = { viewContext ->
            PlayerView(viewContext).apply {
                useController = false
                resizeMode = AspectRatioFrameLayout.RESIZE_MODE_ZOOM
                this.player = player
            }
        },
        update = { it.player = player }
    )
}

@Composable
private fun WebStreamPreview(url: String, modifier: Modifier = Modifier) {
    AndroidView(
        modifier = modifier.background(Color.Black),
        factory = { context ->
            WebView(context).apply {
                setBackgroundColor(android.graphics.Color.BLACK)
                webViewClient = WebViewClient()
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.mediaPlaybackRequiresUserGesture = false
                settings.cacheMode = WebSettings.LOAD_NO_CACHE
                loadUrl(url)
            }
        },
        update = { webView ->
            if (webView.url != url) {
                webView.loadUrl(url)
            }
        }
    )
}

private fun localStreamSetupHint(protocol: String, streamUrl: String, status: String): String? {
    if (protocol != "rtmp" && protocol != "srt" && protocol != "webrtc") {
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
        return "Local RTMP setup: run python3 examples/local-demo-cloud/server.py, paste the printed RTMP publish URL here, then start streaming. The app previews the derived HLS URL; the printed ffplay command is optional for debugging."
    }
    if (protocol == "srt") {
        return "Local SRT setup: run python3 examples/local-demo-cloud/server.py, paste the printed SRT publish URL here, then start streaming. The app previews the derived HLS URL; the printed SRT ffplay command is optional for debugging."
    }
    return "Local WebRTC setup: run python3 examples/local-demo-cloud/server.py, paste the printed WHIP publish URL here, then start streaming. The app previews the MediaMTX WebRTC page."
}

@Composable
private fun CloudServerToggle(enabled: Boolean, onEnabledChange: (Boolean) -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(AppColor.ink.copy(alpha = 0.04f))
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(
            "Use cloud server",
            color = AppColor.ink,
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
        )
        Switch(checked = enabled, onCheckedChange = onEnabledChange)
    }
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
