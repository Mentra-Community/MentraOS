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
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.Camera
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.mentra.examples.android.MentraExampleController
import com.mentra.examples.android.PhotoDestination
import com.mentra.examples.android.cameraSdkCall
import com.mentra.examples.android.isGlassesConnected
import com.mentra.examples.android.photoCompressionOptions
import com.mentra.examples.android.photoSizeOptions
import com.mentra.examples.android.ui.AppColor
import com.mentra.examples.android.ui.Eyebrow
import com.mentra.examples.android.ui.GlassCard
import com.mentra.examples.android.ui.OfflineNotice
import com.mentra.examples.android.ui.PageHeader
import com.mentra.examples.android.ui.scrollBottomPadding

@Composable
fun CameraScreen(controller: MentraExampleController) {
    val state = controller.state
    val connected = isGlassesConnected(state.glassesStatus)
    val directPhone = state.photoDestination == PhotoDestination.THIS_PHONE
    val cameraStatusFailed = isCameraStatusFailure(state.cameraStatus)
    val setupHint = if (directPhone) null else localCameraSetupHint(state.webhookUrl, state.cameraStatus)
    val sdkCall = cameraSdkCall(state.photoSize, state.photoCompression, state.photoFlash)
    val clipboardManager = LocalClipboardManager.current
    Column(modifier = Modifier.fillMaxSize().background(AppColor.bg).verticalScroll(rememberScrollState())) {
        PageHeader("Camera", connected)
        if (!connected) {
            OfflineNotice(modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
        }

        // Preview card
        GlassCard(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            padding = PaddingValues(horizontal = 8.dp, vertical = 8.dp)
        ) {
            Box(
                modifier = Modifier
                    .fillMaxWidth().height(160.dp)
                    .clip(RoundedCornerShape(22.dp))
                    .background(Brush.linearGradient(listOf(Color(0xFF1F4A33), Color(0xFF3A8A56), Color(0xFF7DD89E), Color(0xFF26B870), Color(0xFF163A26))))
            ) {
                if (state.photoPreviewUrl != null) {
                    AsyncImage(model = state.photoPreviewUrl, contentDescription = "Latest photo preview", modifier = Modifier.fillMaxSize())
                }
                Box(modifier = Modifier.align(Alignment.TopEnd).offset(x = (-50).dp, y = 30.dp).size(80.dp).clip(CircleShape).background(Color.White.copy(alpha = 0.55f)))
                Row(modifier = Modifier.align(Alignment.BottomStart).padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Row(
                        modifier = Modifier
                            .clip(RoundedCornerShape(999.dp))
                            .background(Color.Black.copy(alpha = 0.35f))
                            .border(1.dp, Color.White.copy(alpha = 0.18f), RoundedCornerShape(999.dp))
                            .padding(horizontal = 10.dp, vertical = 5.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        Box(modifier = Modifier.size(5.dp).clip(CircleShape).background(AppColor.greenSoft))
                        Text(if (state.photoPreviewUrl != null) "JPEG · uploaded" else "JPEG · waiting", color = Color.White, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
                Text(if (state.photoPreviewUrl != null) "latest" else "ready", color = Color.White.copy(alpha = 0.85f), fontSize = 10.sp, fontWeight = FontWeight.Medium, modifier = Modifier.align(Alignment.BottomEnd).padding(14.dp))
            }
            Spacer(Modifier.height(14.dp))
            Box(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp)
                    .clip(RoundedCornerShape(18.dp))
                    .background(Brush.verticalGradient(listOf(Color(0xFF26473A), Color(0xFF1F3A2A))))
                    .clickable(enabled = connected) { controller.captureAndUpload() }
                    .padding(vertical = 16.dp),
                contentAlignment = Alignment.Center
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Icon(Icons.Outlined.Camera, null, tint = Color.White, modifier = Modifier.size(16.dp))
                    Text(
                        if (!connected) {
                            "Connect glasses first"
                        } else if (state.activeAction == "Capture & upload") {
                            "Capturing..."
                        } else if (directPhone) {
                            "Capture to phone"
                        } else {
                            "Capture & upload"
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
                            .clickable { clipboardManager.setText(AnnotatedString(sdkCall)) }
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
                    sdkCall,
                    color = AppColor.consoleText, fontSize = 11.sp, fontFamily = FontFamily.Monospace
                )
            }
            Row(
                modifier = Modifier.fillMaxWidth().background(Color.White.copy(alpha = 0.6f)).padding(horizontal = 16.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                Box(
                    modifier = Modifier
                        .size(22.dp)
                        .clip(CircleShape)
                        .background((if (cameraStatusFailed) AppColor.red else AppColor.greenAccent).copy(alpha = 0.16f)),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(
                        if (cameraStatusFailed) Icons.Filled.Close else Icons.Filled.Check,
                        null,
                        tint = if (cameraStatusFailed) AppColor.red else AppColor.greenAccent,
                        modifier = Modifier.size(12.dp)
                    )
                }
                Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                    Text(state.cameraStatus, color = AppColor.ink, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                    Text(
                        when {
                            state.photoPreviewUrl != null && directPhone -> "Preview loaded from phone receiver"
                            state.photoPreviewUrl != null -> "Preview loaded from local webhook"
                            directPhone && state.phonePhotoServerRunning -> state.phonePhotoUploadUrl
                            directPhone -> "Phone receiver starts on capture"
                            else -> "Waiting for capture"
                        },
                        color = AppColor.muted,
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Medium
                    )
                }
            }
        }

        // Upload card
        GlassCard(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            corner = 22,
            padding = PaddingValues(horizontal = 18.dp, vertical = 16.dp)
        ) {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Eyebrow("UPLOAD TO")
                if (!directPhone) {
                    Text(
                        "test webhook",
                        color = AppColor.greenAccent,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Medium,
                        modifier = Modifier.clickable { controller.testWebhook() }
                    )
                }
            }
            Spacer(Modifier.height(12.dp))
            CameraOptionGroup("send to") {
                OptionChip("MacBook", state.photoDestination == PhotoDestination.MACBOOK_SERVER) {
                    controller.setPhotoDestination(PhotoDestination.MACBOOK_SERVER)
                }
                OptionChip("This phone", directPhone) {
                    controller.setPhotoDestination(PhotoDestination.THIS_PHONE)
                }
            }
            Spacer(Modifier.height(12.dp))
            Row(
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(AppColor.ink.copy(alpha = 0.04f)).padding(horizontal = 14.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                Text("POST", color = AppColor.greenAccent, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.5.sp)
                Box(modifier = Modifier.size(width = 1.dp, height = 14.dp).background(AppColor.ink.copy(alpha = 0.12f)))
                if (directPhone) {
                    Text(
                        state.phonePhotoUploadUrl,
                        color = AppColor.ink,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Medium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f)
                    )
                    Box(modifier = Modifier.size(7.dp).clip(CircleShape).background(if (state.phonePhotoServerRunning) AppColor.greenAccent else AppColor.muted))
                } else {
                    BasicTextField(
                        value = state.webhookUrl,
                        onValueChange = controller::setWebhookUrl,
                        singleLine = true,
                        textStyle = androidx.compose.ui.text.TextStyle(color = AppColor.ink, fontSize = 13.sp, fontWeight = FontWeight.Medium),
                        modifier = Modifier.weight(1f),
                        decorationBox = { inner ->
                            if (state.webhookUrl.isBlank()) {
                                Text("Photo upload URL", color = AppColor.muted, fontSize = 13.sp)
                            }
                            inner()
                        }
                    )
                }
            }
            Spacer(Modifier.height(12.dp))
            if (setupHint != null) {
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
                Spacer(Modifier.height(12.dp))
            }
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                CameraOptionGroup("size") {
                    photoSizeOptions.forEach { size ->
                        OptionChip(size, state.photoSize == size) { controller.setPhotoSize(size) }
                    }
                }
                CameraOptionGroup("compress") {
                    photoCompressionOptions.forEach { compression ->
                        OptionChip(compression, state.photoCompression == compression) {
                            controller.setPhotoCompression(compression)
                        }
                    }
                }
                CameraOptionGroup("flash") {
                    OptionChip("off", !state.photoFlash) { controller.setPhotoFlash(false) }
                    OptionChip("on", state.photoFlash) { controller.setPhotoFlash(true) }
                }
            }
        }

        Spacer(Modifier.height(scrollBottomPadding()))
    }
}

private fun isCameraStatusFailure(status: String): Boolean {
    val normalized = status.lowercase()
    return normalized.contains("failed") ||
        normalized.contains("returned http") ||
        normalized.contains("timed out") ||
        normalized.contains("reported") ||
        normalized.contains("invalid") ||
        normalized.contains("replace <computer-ip>") ||
        normalized.contains("valid http") ||
        normalized.contains("enter a webhook url like") ||
        normalized.contains("no phone lan ip") ||
        normalized.contains("phone receiver failed")
}

private fun localCameraSetupHint(webhookUrl: String, status: String): String? {
    val normalized = status.lowercase()
    val needsSetup = webhookUrl.trim().isEmpty() ||
        webhookUrl.contains("<computer-ip>") ||
        normalized.contains("webhook test failed") ||
        normalized.contains("returned http") ||
        normalized.contains("timed out") ||
        normalized.contains("valid http") ||
        normalized.contains("enter a webhook url like")
    if (!needsSetup) {
        return null
    }
    return "Local setup: run python3 examples/local-demo-cloud/server.py from the Partner Kit repo root, then paste the printed Photo upload URL here. It looks like http://<computer-ip>:8787/upload."
}

@Composable
private fun CameraOptionGroup(label: String, content: @Composable RowScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            label.uppercase(),
            color = AppColor.muted,
            fontSize = 10.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 1.1.sp,
            maxLines = 1
        )
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
            content = content
        )
    }
}

@Composable
private fun OptionChip(value: String, active: Boolean, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(if (active) AppColor.greenAccent.copy(alpha = 0.16f) else Color.White.copy(alpha = 0.6f))
            .border(
                1.dp,
                if (active) AppColor.greenAccent.copy(alpha = 0.32f) else AppColor.ink.copy(alpha = 0.06f),
                RoundedCornerShape(999.dp)
            )
            .clickable { onClick() }
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Text(value, color = if (active) AppColor.greenAccent else AppColor.ink, fontSize = 12.sp, fontWeight = FontWeight.Bold, maxLines = 1)
    }
}
