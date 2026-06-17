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
import androidx.compose.material.icons.outlined.Videocam
import androidx.compose.material3.Icon
import androidx.compose.material3.Slider
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import coil.compose.AsyncImage
import com.mentra.examples.android.MentraExampleController
import com.mentra.examples.android.CAMERA_FOV_DEFAULT
import com.mentra.examples.android.CAMERA_FOV_MAX
import com.mentra.examples.android.CAMERA_FOV_MIN
import com.mentra.examples.android.PHOTO_EXPOSURE_DEFAULT_NS
import com.mentra.examples.android.PHOTO_EXPOSURE_MAX_NS
import com.mentra.examples.android.PHOTO_EXPOSURE_MIN_NS
import com.mentra.examples.android.PHOTO_ISO_DEFAULT
import com.mentra.examples.android.PHOTO_ISO_MAX
import com.mentra.examples.android.PHOTO_ISO_MIN
import com.mentra.examples.android.PhotoPreviewDetails
import com.mentra.examples.android.PhotoDestination
import com.mentra.examples.android.VideoPreviewDetails
import com.mentra.examples.android.cameraRoiPositions
import com.mentra.examples.android.cameraSdkCall
import com.mentra.examples.android.isGlassesConnected
import com.mentra.examples.android.isGlassesWifiConnected
import com.mentra.examples.android.photoAeExposureDivisorOptions
import com.mentra.examples.android.photoCompressionOptions
import com.mentra.examples.android.photoIspAnalogGainOptions
import com.mentra.examples.android.photoIspDigitalGainOptions
import com.mentra.examples.android.photoIsoCapOptions
import com.mentra.examples.android.photoSizeOptions
import com.mentra.examples.android.roiPositionLabel
import com.mentra.examples.android.ui.AppColor
import com.mentra.examples.android.ui.Eyebrow
import com.mentra.examples.android.ui.GlassCard
import com.mentra.examples.android.ui.OfflineNotice
import com.mentra.examples.android.ui.PageHeader
import com.mentra.examples.android.ui.scrollBottomPadding
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.roundToInt

private enum class CameraCaptureMode {
    PHOTO,
    VIDEO,
}

@Composable
fun CameraScreen(controller: MentraExampleController) {
    val state = controller.state
    val connected = isGlassesConnected(state.glassesStatus)
    val glassesWifiConnected = isGlassesWifiConnected(state.glassesStatus)
    val wifiRequired = connected && !glassesWifiConnected
    val cloudServerEnabled = state.photoDestination == PhotoDestination.MACBOOK_SERVER
    val directPhone = !cloudServerEnabled
    val videoActionBusy = state.activeAction == "Start video recording" || state.activeAction == "Stop & upload video"
    val videoControlsEnabled = connected &&
        glassesWifiConnected &&
        !videoActionBusy
    val cameraStatusFailed = isCameraStatusFailure(state.cameraStatus)
    var captureMode by remember { mutableStateOf(CameraCaptureMode.PHOTO) }
    val videoMode = captureMode == CameraCaptureMode.VIDEO
    val setupHint = if (cloudServerEnabled || videoMode) localCameraSetupHint(state.webhookUrl, state.cameraStatus) else null
    val sdkCall = cameraSdkCall(
        if (videoMode) "video" else "photo",
        state.photoSize,
        state.photoCompression,
        state.photoAeExposureDivisor,
        state.photoIsoCap,
        state.photoNoiseReduction,
        state.photoEdgeEnhancement,
        state.photoMfnr,
        state.photoZsl,
        state.photoIspDigitalGain,
        state.photoIspAnalogGain,
        state.photoExposureManual,
        state.photoExposureTimeNs,
        state.photoIso,
        state.cameraFov,
        state.cameraRoiPosition,
        state.scanMode,
    )
    val clipboardManager = LocalClipboardManager.current
    var photoDetailsExpanded by remember { mutableStateOf(false) }
    var videoDetailsExpanded by remember { mutableStateOf(false) }
    LaunchedEffect(state.activeAction, state.videoRecording) {
        when {
            state.videoRecording ||
                state.activeAction == "Start video recording" ||
                state.activeAction == "Stop & upload video" -> captureMode = CameraCaptureMode.VIDEO
            state.activeAction == "Capture & upload" -> captureMode = CameraCaptureMode.PHOTO
        }
    }
    Column(modifier = Modifier.fillMaxSize().background(AppColor.bg).verticalScroll(rememberScrollState())) {
        PageHeader("Camera")
        if (!connected) {
            OfflineNotice(modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
        } else if (wifiRequired) {
            OfflineNotice(
                message = "Connect the glasses to Wi-Fi from the System tab before capturing photos. Photos are uploaded over the glasses network connection.",
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)
            )
        }

        CaptureModeSelector(
            activeMode = captureMode,
            onModeChange = { captureMode = it },
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)
        )

        // Preview card
        if (captureMode == CameraCaptureMode.PHOTO) {
            GlassCard(
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                padding = PaddingValues(horizontal = 8.dp, vertical = 8.dp)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Eyebrow("PHOTO")
                    Column(horizontalAlignment = Alignment.End) {
                        Text(
                            if (!connected) {
                                "Connect glasses first"
                            } else if (!glassesWifiConnected) {
                                "Connect glasses to Wi-Fi"
                            } else if (state.activeAction == "Capture & upload" || state.activeAction == "Capture scan photo") {
                                "Capturing..."
                            } else if (state.scanMode) {
                                "Capture scan photo"
                            } else {
                                "Capture photo"
                            },
                            color = Color.White,
                            fontSize = 15.sp,
                            fontWeight = FontWeight.SemiBold
                        )
                        if (state.photoPreviewUrl != null || state.photoPreviewDetails?.state == "error" || state.photoPreviewDetails?.state == "acknowledged") {
                            Text(
                                photoStateLabel(state.photoPreviewUrl, state.photoPreviewDetails),
                                color = AppColor.greenAccent,
                                fontSize = 11.sp,
                                fontWeight = FontWeight.Bold,
                            )
                        }
                    }
                }
                Box(
                    modifier = Modifier
                        .fillMaxWidth().height(160.dp)
                        .clip(RoundedCornerShape(22.dp))
                        .background(Brush.linearGradient(listOf(Color(0xFF1F4A33), Color(0xFF3A8A56), Color(0xFF7DD89E), Color(0xFF26B870), Color(0xFF163A26))))
                ) {
                    if (state.photoPreviewUrl != null) {
                        AsyncImage(
                            model = state.photoPreviewUrl,
                            contentDescription = "Latest photo preview",
                            contentScale = ContentScale.Crop,
                            modifier = Modifier.fillMaxSize()
                        )
                    } else {
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
                                Text("JPEG · waiting", color = Color.White, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
                            }
                        }
                        Text("ready", color = Color.White.copy(alpha = 0.85f), fontSize = 10.sp, fontWeight = FontWeight.Medium, modifier = Modifier.align(Alignment.BottomEnd).padding(14.dp))
                    }
                }
                Spacer(Modifier.height(14.dp))
                Box(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp)
                        .clip(RoundedCornerShape(18.dp))
                        .background(Brush.verticalGradient(listOf(Color(0xFF26473A), Color(0xFF1F3A2A))))
                        .clickable(enabled = connected && glassesWifiConnected) { controller.captureAndUpload() }
                        .padding(vertical = 16.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Icon(Icons.Outlined.Camera, null, tint = Color.White, modifier = Modifier.size(16.dp))
                        Text(
                            if (!connected) {
                                "Connect glasses first"
                            } else if (!glassesWifiConnected) {
                                "Connect glasses to Wi-Fi"
                            } else if (state.activeAction == "Capture & upload" || state.activeAction == "Capture scan photo") {
                                "Capturing..."
                            } else if (state.scanMode) {
                                "Capture scan photo"
                            } else {
                                "Capture photo"
                            },
                            color = Color.White,
                            fontSize = 15.sp,
                            fontWeight = FontWeight.SemiBold
                        )
                    }
                }
                Spacer(Modifier.height(12.dp))
                ScanModeSettingsCard(controller)
                Spacer(Modifier.height(12.dp))
                PhotoDetailsCard(
                    details = state.photoPreviewDetails,
                    embedded = true,
                    expanded = photoDetailsExpanded,
                    onToggle = { photoDetailsExpanded = !photoDetailsExpanded },
                    modifier = Modifier.padding(horizontal = 6.dp)
                )
            }
        }

        if (captureMode == CameraCaptureMode.VIDEO) {
            GlassCard(
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                corner = 22,
                padding = PaddingValues(horizontal = 14.dp, vertical = 14.dp)
            ) {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Eyebrow("VIDEO RECORDING")
                    Text(
                        when {
                            state.videoRecording -> "recording"
                            state.videoPreviewUrl != null -> "preview ready"
                            else -> state.videoPreviewDetails?.state ?: "ready"
                        }.uppercase(Locale.US),
                        color = AppColor.greenAccent,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Bold,
                    )
                }
                Spacer(Modifier.height(12.dp))
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(170.dp)
                        .clip(RoundedCornerShape(18.dp))
                        .background(Brush.linearGradient(listOf(Color(0xFF101820), Color(0xFF21383B), Color(0xFF357064))))
                ) {
                    if (state.videoPreviewUrl != null) {
                        VideoPreview(state.videoPreviewUrl, modifier = Modifier.fillMaxSize())
                    } else {
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
                                Text("MP4 · waiting", color = Color.White, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
                            }
                        }
                        Text(
                            if (state.videoRecording) "recording" else "ready",
                            color = Color.White.copy(alpha = 0.85f),
                            fontSize = 10.sp,
                            fontWeight = FontWeight.Medium,
                            modifier = Modifier.align(Alignment.BottomEnd).padding(14.dp)
                        )
                    }
                }
                Spacer(Modifier.height(14.dp))
                Box(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp)
                        .clip(RoundedCornerShape(18.dp))
                        .background(Brush.verticalGradient(listOf(Color(0xFF223F4D), Color(0xFF182C38))))
                        .clickable(enabled = videoControlsEnabled) { controller.toggleVideoRecording() }
                        .padding(vertical = 16.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Icon(Icons.Outlined.Videocam, null, tint = Color.White, modifier = Modifier.size(16.dp))
                        Text(
                            when {
                                !connected -> "Connect glasses first"
                                !glassesWifiConnected -> "Connect glasses to Wi-Fi"
                                state.activeAction == "Start video recording" -> "Starting video..."
                                state.activeAction == "Stop & upload video" -> "Uploading video..."
                                state.videoRecording -> "Stop & upload video"
                                else -> "Start video"
                            },
                            color = Color.White,
                            fontSize = 15.sp,
                            fontWeight = FontWeight.SemiBold
                        )
                    }
                }
                Spacer(Modifier.height(12.dp))
                VideoDetailsPanel(
                    details = state.videoPreviewDetails,
                    expanded = videoDetailsExpanded,
                    onToggle = { videoDetailsExpanded = !videoDetailsExpanded },
                )
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
                            .clip(RoundedCornerShape(9.dp))
                            .background(Color.White.copy(alpha = 0.06f))
                            .clickable { clipboardManager.setText(AnnotatedString(sdkCall)) }
                            .heightIn(min = 36.dp)
                            .padding(horizontal = 10.dp, vertical = 7.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp)
                    ) {
                        Icon(Icons.Outlined.ContentCopy, null, tint = AppColor.consoleText, modifier = Modifier.size(12.dp))
                        Text("Copy", color = AppColor.consoleText, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
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
                    Text(state.cameraStatus, color = AppColor.ink, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                    Text(
                        if (videoMode) {
                            when {
                                state.videoRecording -> "Recording MP4 on glasses"
                                state.videoPreviewUrl != null -> "Video preview loaded from media server"
                                else -> "MP4 uploads to the media server after recording stops"
                            }
                        } else {
                            when {
                            state.photoPreviewUrl != null && directPhone -> "Photo preview loaded from phone receiver"
                            state.photoPreviewUrl != null -> "Photo preview loaded from cloud server"
                            directPhone && state.phonePhotoServerRunning -> "Phone receiver ready"
                            directPhone -> "Phone receiver starts on capture"
                            else -> "Waiting for media upload"
                            }
                        },
                        color = AppColor.muted,
                        fontSize = 11.sp,
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
                if (videoMode || cloudServerEnabled) {
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
            if (videoMode) {
                FixedMediaServerRow()
                Spacer(Modifier.height(12.dp))
                Text(
                    "Cloud server receives MP4 uploads.",
                    color = AppColor.muted,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Medium,
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(12.dp))
                Row(
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(AppColor.ink.copy(alpha = 0.04f)).padding(horizontal = 14.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    Text("POST", color = AppColor.greenAccent, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.5.sp)
                    Box(modifier = Modifier.size(width = 1.dp, height = 14.dp).background(AppColor.ink.copy(alpha = 0.12f)))
                    BasicTextField(
                        value = state.webhookUrl,
                        onValueChange = controller::setWebhookUrl,
                        singleLine = true,
                        textStyle = androidx.compose.ui.text.TextStyle(color = AppColor.ink, fontSize = 13.sp, fontWeight = FontWeight.Medium),
                        modifier = Modifier.weight(1f),
                        decorationBox = { inner ->
                            if (state.webhookUrl.isBlank()) {
                                Text("Media upload URL", color = AppColor.muted, fontSize = 13.sp)
                            }
                            inner()
                        }
                    )
                }
                Spacer(Modifier.height(12.dp))
            } else {
                CloudServerToggle(
                    enabled = cloudServerEnabled,
                    onEnabledChange = { enabled ->
                        controller.setPhotoDestination(if (enabled) PhotoDestination.MACBOOK_SERVER else PhotoDestination.THIS_PHONE)
                    },
                )
                Spacer(Modifier.height(12.dp))
                if (cloudServerEnabled) {
                    Text(
                        "Cloud server receives photo uploads.",
                        color = AppColor.muted,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Medium,
                        modifier = Modifier.fillMaxWidth()
                    )
                    Spacer(Modifier.height(12.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(AppColor.ink.copy(alpha = 0.04f)).padding(horizontal = 14.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        Text("POST", color = AppColor.greenAccent, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.5.sp)
                        Box(modifier = Modifier.size(width = 1.dp, height = 14.dp).background(AppColor.ink.copy(alpha = 0.12f)))
                        BasicTextField(
                            value = state.webhookUrl,
                            onValueChange = controller::setWebhookUrl,
                            singleLine = true,
                            textStyle = androidx.compose.ui.text.TextStyle(color = AppColor.ink, fontSize = 13.sp, fontWeight = FontWeight.Medium),
                            modifier = Modifier.weight(1f),
                            decorationBox = { inner ->
                                if (state.webhookUrl.isBlank()) {
                                    Text("Media upload URL", color = AppColor.muted, fontSize = 13.sp)
                                }
                                inner()
                            }
                        )
                    }
                    Spacer(Modifier.height(12.dp))
                } else {
                    Row(
                        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(AppColor.ink.copy(alpha = 0.04f)).padding(horizontal = 14.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        Box(modifier = Modifier.size(7.dp).clip(CircleShape).background(if (state.phonePhotoServerRunning) AppColor.greenAccent else AppColor.muted))
                        Text(
                            if (state.phonePhotoServerRunning) "Phone receiver ready" else "Phone receiver starts on capture",
                            color = AppColor.ink,
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Medium,
                            modifier = Modifier.weight(1f)
                        )
                    }
                    Spacer(Modifier.height(12.dp))
                }
            }
            if (setupHint != null) {
                Text(
                    setupHint,
                    color = AppColor.muted,
                    fontSize = 12.sp,
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
                if (captureMode == CameraCaptureMode.PHOTO) {
                    CameraOptionGroup("photo size") {
                        photoSizeOptions.forEach { size ->
                            OptionChip(
                                size,
                                state.photoSize == size,
                            ) { controller.setPhotoSize(size) }
                        }
                    }
                    CameraOptionGroup("photo compress") {
                        photoCompressionOptions.forEach { compression ->
                            OptionChip(compression, state.photoCompression == compression) {
                                controller.setPhotoCompression(compression)
                            }
                        }
                    }
                    ExposureSettingsCard(controller)
                    PhotoRequestTuningSettingsCard(controller)
                }
                CameraFovSettingsCard(controller)
            }
        }

        Spacer(Modifier.height(scrollBottomPadding()))
    }
}

@Composable
private fun ScanModeSettingsCard(controller: MentraExampleController) {
    val state = controller.state
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(AppColor.ink.copy(alpha = 0.04f))
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("SCAN MODE", color = AppColor.muted, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.1.sp)
                Text(
                    if (state.scanMode) "Barcode capture preset" else "Standard photo capture",
                    color = AppColor.greenAccent,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                )
            }
            Switch(checked = state.scanMode, onCheckedChange = controller::setScanMode)
        }
        if (state.scanMode) {
            Text(
                "Applies the barcode capture preset and keeps the glasses button preset in sync. Tune the live request fields below.",
                color = AppColor.muted,
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
            )
        }
    }
}

@Composable
private fun ExposureSettingsCard(controller: MentraExampleController) {
    val state = controller.state
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(AppColor.ink.copy(alpha = 0.04f))
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("EXPOSURE", color = AppColor.muted, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.1.sp)
                Text(
                    if (state.photoExposureManual) exposureLabel(state.photoExposureTimeNs) else "Auto exposure",
                    color = AppColor.greenAccent,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                )
            }
            Switch(checked = state.photoExposureManual, onCheckedChange = controller::setPhotoExposureManual)
        }
        if (state.photoExposureManual) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                SliderNudgeButton("-", enabled = state.photoExposureTimeNs > PHOTO_EXPOSURE_MIN_NS) {
                    controller.setPhotoExposureTimeNs(state.photoExposureTimeNs - 500_000)
                }
                Slider(
                    value = state.photoExposureTimeNs.toFloat(),
                    onValueChange = { controller.setPhotoExposureTimeNs((it / 500_000f).roundToInt() * 500_000) },
                    valueRange = PHOTO_EXPOSURE_MIN_NS.toFloat()..PHOTO_EXPOSURE_MAX_NS.toFloat(),
                    modifier = Modifier.weight(1f),
                )
                SliderNudgeButton("+", enabled = state.photoExposureTimeNs < PHOTO_EXPOSURE_MAX_NS) {
                    controller.setPhotoExposureTimeNs(state.photoExposureTimeNs + 500_000)
                }
            }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                Text("1/1000s", color = AppColor.muted, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                Text(
                    "Preset 1/120s",
                    color = AppColor.greenAccent,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.clickable { controller.setPhotoExposureTimeNs(PHOTO_EXPOSURE_DEFAULT_NS) }
                )
                Text("1/30s", color = AppColor.muted, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
            }
        }
        Spacer(Modifier.height(4.dp))
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("ISO", color = AppColor.muted, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.1.sp)
            Text(
                if (state.photoExposureManual) "ISO ${state.photoIso}" else "Auto ISO",
                color = AppColor.greenAccent,
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold,
            )
        }
        if (state.photoExposureManual) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                SliderNudgeButton("-", enabled = state.photoIso > PHOTO_ISO_MIN) {
                    controller.setPhotoIso(state.photoIso - 50)
                }
                Slider(
                    value = state.photoIso.toFloat(),
                    onValueChange = { controller.setPhotoIso((it / 50f).roundToInt() * 50) },
                    valueRange = PHOTO_ISO_MIN.toFloat()..PHOTO_ISO_MAX.toFloat(),
                    modifier = Modifier.weight(1f),
                )
                SliderNudgeButton("+", enabled = state.photoIso < PHOTO_ISO_MAX) {
                    controller.setPhotoIso(state.photoIso + 50)
                }
            }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                Text("ISO $PHOTO_ISO_MIN", color = AppColor.muted, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                Text(
                    "Preset ISO $PHOTO_ISO_DEFAULT",
                    color = AppColor.greenAccent,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.clickable { controller.setPhotoIso(PHOTO_ISO_DEFAULT) }
                )
                Text("ISO $PHOTO_ISO_MAX", color = AppColor.muted, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

@Composable
private fun PhotoRequestTuningSettingsCard(controller: MentraExampleController) {
    val state = controller.state
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(AppColor.ink.copy(alpha = 0.04f))
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("PHOTO REQUEST TUNING", color = AppColor.muted, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.1.sp)
            Text("Optional request parameters", color = AppColor.greenAccent, fontSize = 12.sp, fontWeight = FontWeight.Bold)
        }
        CameraOptionGroup("ae divisor") {
            OptionChip("Unset", state.photoAeExposureDivisor == null) { controller.setPhotoAeExposureDivisor(null) }
            photoAeExposureDivisorOptions.forEach { divisor ->
                OptionChip("÷$divisor", state.photoAeExposureDivisor == divisor) {
                    controller.setPhotoAeExposureDivisor(divisor)
                }
            }
        }
        CameraOptionGroup("iso cap") {
            OptionChip("Unset", state.photoIsoCap == null) { controller.setPhotoIsoCap(null) }
            photoIsoCapOptions.forEach { isoCap ->
                OptionChip("$isoCap", state.photoIsoCap == isoCap) { controller.setPhotoIsoCap(isoCap) }
            }
        }
        TuningFlagOptionGroup("noise reduction", state.photoNoiseReduction, controller::setPhotoNoiseReduction)
        TuningFlagOptionGroup("edge enhancement", state.photoEdgeEnhancement, controller::setPhotoEdgeEnhancement)
        TuningFlagOptionGroup("mfnr", state.photoMfnr, controller::setPhotoMfnr)
        TuningFlagOptionGroup("zsl", state.photoZsl, controller::setPhotoZsl)
        CameraOptionGroup("isp digital gain") {
            OptionChip("Unset", state.photoIspDigitalGain == null) { controller.setPhotoIspDigitalGain(null) }
            photoIspDigitalGainOptions.forEach { gain ->
                OptionChip("$gain", state.photoIspDigitalGain == gain) { controller.setPhotoIspDigitalGain(gain) }
            }
        }
        CameraOptionGroup("isp analog gain") {
            OptionChip("Unset", state.photoIspAnalogGain == null) { controller.setPhotoIspAnalogGain(null) }
            photoIspAnalogGainOptions.forEach { gain ->
                OptionChip(gain, state.photoIspAnalogGain == gain) { controller.setPhotoIspAnalogGain(gain) }
            }
        }
    }
}

@Composable
private fun TuningFlagOptionGroup(label: String, value: Boolean?, onChange: (Boolean?) -> Unit) {
    CameraOptionGroup(label) {
        OptionChip("Unset", value == null) { onChange(null) }
        OptionChip("On", value == true) { onChange(true) }
        OptionChip("Off", value == false) { onChange(false) }
    }
}

@Composable
private fun CameraFovSettingsCard(controller: MentraExampleController) {
    val state = controller.state
    val roiDisabled = state.cameraFov == CAMERA_FOV_MAX
    val controlsEnabled = !state.cameraSettingsApplying
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(AppColor.ink.copy(alpha = 0.04f))
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("FIELD OF VIEW", color = AppColor.muted, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.1.sp)
                Text(
                    "${state.cameraFov}° · ${if (roiDisabled) "full sensor" else "${roiPositionLabel(state.cameraRoiPosition)} crop"}",
                    color = AppColor.greenAccent,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                )
            }
            Text(
                if (state.cameraSettingsApplying) "Applying..." else "Apply",
                color = if (controlsEnabled) AppColor.greenAccent else AppColor.muted,
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .clip(RoundedCornerShape(999.dp))
                    .background(AppColor.greenAccent.copy(alpha = 0.16f))
                    .border(1.dp, AppColor.greenAccent.copy(alpha = 0.28f), RoundedCornerShape(999.dp))
                    .clickable(enabled = controlsEnabled) { controller.applyCameraSettings() }
                    .padding(horizontal = 12.dp, vertical = 8.dp)
            )
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            SliderNudgeButton("-", enabled = controlsEnabled && state.cameraFov > CAMERA_FOV_MIN) {
                controller.setCameraFov(state.cameraFov - 1)
            }
            Slider(
                enabled = controlsEnabled,
                value = state.cameraFov.toFloat(),
                onValueChange = { controller.setCameraFov(it.toInt()) },
                valueRange = CAMERA_FOV_MIN.toFloat()..CAMERA_FOV_MAX.toFloat(),
                steps = CAMERA_FOV_MAX - CAMERA_FOV_MIN - 1,
                modifier = Modifier.weight(1f),
            )
            SliderNudgeButton("+", enabled = controlsEnabled && state.cameraFov < CAMERA_FOV_MAX) {
                controller.setCameraFov(state.cameraFov + 1)
            }
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            Text("${CAMERA_FOV_MIN}°", color = AppColor.muted, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
            Text(
                "Preset ${CAMERA_FOV_DEFAULT}°",
                color = if (controlsEnabled) AppColor.greenAccent else AppColor.muted,
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.clickable(enabled = controlsEnabled) { controller.setCameraFov(CAMERA_FOV_DEFAULT) }
            )
            Text("${CAMERA_FOV_MAX}°", color = AppColor.muted, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
        }
        CameraOptionGroup("crop position") {
            cameraRoiPositions.forEach { option ->
                OptionChip(option.first, state.cameraRoiPosition == option.second, enabled = controlsEnabled && !roiDisabled) {
                    controller.setCameraRoiPosition(option.second)
                }
            }
        }
        Text(
            state.cameraSettingsStatus,
            color = AppColor.muted,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            lineHeight = 16.sp,
        )
    }
}

@Composable
private fun PhotoDetailsCard(
    details: PhotoPreviewDetails?,
    embedded: Boolean = false,
    expanded: Boolean,
    onToggle: () -> Unit,
    modifier: Modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
) {
    @Composable
    fun Content() {
        Row(
            modifier = Modifier.fillMaxWidth().clickable { onToggle() },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Eyebrow("PHOTO DETAILS")
                Text(photoDetailsSummary(details), color = AppColor.ink, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            }
            Text(if (expanded) "Hide" else "Show", color = AppColor.greenAccent, fontSize = 12.sp, fontWeight = FontWeight.Bold)
        }
        if (expanded) {
            Spacer(Modifier.height(12.dp))
            Box(Modifier.fillMaxWidth().height(1.dp).background(AppColor.ink.copy(alpha = 0.08f)))
            Spacer(Modifier.height(8.dp))
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                photoDetailsRows(details).forEach { row ->
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.Top
                    ) {
                        Text(row.first, color = AppColor.muted, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                        Text(
                            row.second,
                            color = AppColor.ink,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.weight(1f),
                            textAlign = androidx.compose.ui.text.style.TextAlign.End
                        )
                    }
                }
            }
        }
    }

    if (embedded) {
        Column(
            modifier = modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(14.dp))
                .background(AppColor.ink.copy(alpha = 0.04f))
                .border(1.dp, AppColor.ink.copy(alpha = 0.08f), RoundedCornerShape(14.dp))
                .padding(horizontal = 12.dp, vertical = 12.dp)
        ) {
            Content()
        }
        return
    }

    GlassCard(
        modifier = modifier,
        corner = 18,
        padding = PaddingValues(horizontal = 14.dp, vertical = 12.dp)
    ) {
        Content()
    }
}

@Composable
private fun CaptureModeSelector(
    activeMode: CameraCaptureMode,
    onModeChange: (CameraCaptureMode) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(AppColor.ink.copy(alpha = 0.05f))
            .border(1.dp, AppColor.ink.copy(alpha = 0.08f), RoundedCornerShape(16.dp))
            .padding(4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        CaptureModeButton(
            label = "Photo",
            active = activeMode == CameraCaptureMode.PHOTO,
            icon = { tint -> Icon(Icons.Outlined.Camera, null, tint = tint, modifier = Modifier.size(15.dp)) },
            modifier = Modifier.weight(1f),
            onClick = { onModeChange(CameraCaptureMode.PHOTO) },
        )
        CaptureModeButton(
            label = "Video",
            active = activeMode == CameraCaptureMode.VIDEO,
            icon = { tint -> Icon(Icons.Outlined.Videocam, null, tint = tint, modifier = Modifier.size(15.dp)) },
            modifier = Modifier.weight(1f),
            onClick = { onModeChange(CameraCaptureMode.VIDEO) },
        )
    }
}

@Composable
private fun CaptureModeButton(
    label: String,
    active: Boolean,
    icon: @Composable (Color) -> Unit,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Row(
        modifier = modifier
            .heightIn(min = 42.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(if (active) Color.White else Color.Transparent)
            .border(
                1.dp,
                if (active) AppColor.ink.copy(alpha = 0.08f) else Color.Transparent,
                RoundedCornerShape(12.dp)
            )
            .clickable { onClick() }
            .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically
    ) {
        icon(if (active) AppColor.ink else AppColor.muted)
        Spacer(Modifier.width(8.dp))
        Text(
            label,
            color = if (active) AppColor.ink else AppColor.muted,
            fontSize = 13.sp,
            fontWeight = FontWeight.Bold,
        )
    }
}

private fun photoStateLabel(previewUrl: String?, details: PhotoPreviewDetails?): String =
    when {
        previewUrl != null -> "PREVIEW READY"
        details?.state == "error" -> "ERROR"
        details?.state == "acknowledged" -> "ACKNOWLEDGED"
        else -> "READY"
    }

@Composable
private fun VideoPreview(url: String, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val player = remember(url) {
        ExoPlayer.Builder(context).build().apply {
            setMediaItem(MediaItem.fromUri(url))
            volume = 0f
            playWhenReady = true
            repeatMode = Player.REPEAT_MODE_ALL
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
                useController = true
                controllerAutoShow = true
                controllerShowTimeoutMs = 0
                resizeMode = AspectRatioFrameLayout.RESIZE_MODE_ZOOM
                this.player = player
                showController()
            }
        },
        update = {
            it.player = player
            it.showController()
        }
    )
}

@Composable
private fun VideoDetailsPanel(details: VideoPreviewDetails?, expanded: Boolean, onToggle: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(AppColor.ink.copy(alpha = 0.04f))
            .border(1.dp, AppColor.ink.copy(alpha = 0.08f), RoundedCornerShape(14.dp))
            .padding(horizontal = 12.dp, vertical = 12.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().clickable { onToggle() },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Eyebrow("VIDEO DETAILS")
                Text(videoDetailsSummary(details), color = AppColor.ink, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            }
            Text(if (expanded) "Hide" else "Show", color = AppColor.greenAccent, fontSize = 12.sp, fontWeight = FontWeight.Bold)
        }
        if (expanded) {
            Spacer(Modifier.height(12.dp))
            Box(Modifier.fillMaxWidth().height(1.dp).background(AppColor.ink.copy(alpha = 0.08f)))
            Spacer(Modifier.height(8.dp))
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                videoDetailsRows(details).forEach { row ->
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.Top
                    ) {
                        Text(row.first, color = AppColor.muted, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                        Text(
                            row.second,
                            color = AppColor.ink,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.weight(1f),
                            textAlign = androidx.compose.ui.text.style.TextAlign.End
                        )
                    }
                }
            }
        }
    }
}

private fun photoDetailsSummary(details: PhotoPreviewDetails?): String {
    if (details == null) return "Waiting for first photo preview"
    if (details.state == "error") return "Error · ${details.error ?: "Photo failed"}"
    return listOfNotNull(
        details.source,
        details.byteCount?.let(::formatBytes),
        if (details.width != null && details.height != null) "${details.width} x ${details.height}" else null,
        if (details.state == "acknowledged") "acknowledged" else "preview ready",
    ).joinToString(" · ")
}

private fun videoDetailsSummary(details: VideoPreviewDetails?): String {
    if (details == null) return "Waiting for first video preview"
    if (details.state == "error") return "Error · ${details.error ?: "Video failed"}"
    return listOfNotNull(
        details.source,
        details.byteCount?.let(::formatBytes),
        details.durationMs?.let(::formatDurationMs),
        details.status?.replace("_", " ") ?: details.state,
    ).joinToString(" · ")
}

private fun videoDetailsRows(details: VideoPreviewDetails?): List<Pair<String, String>> {
    if (details == null) return listOf("Status" to "No video metadata received yet")
    return buildList {
        add("Source" to details.source)
        add("State" to details.state)
        details.status?.let { add("SDK status" to it) }
        details.requestId?.let { add("Request ID" to it) }
        details.durationMs?.let { add("Duration" to formatDurationMs(it)) }
        details.byteCount?.let { add("Size" to formatBytes(it)) }
        details.contentType?.let { add("Content type" to it) }
        details.uploadUrl?.let { add("Upload URL" to it) }
        details.mediaUrl?.let { add("SDK media URL" to it) }
        details.previewUrl?.let { add("Preview URL" to it) }
        details.timestamp?.let { add("SDK timestamp" to SimpleDateFormat("HH:mm:ss", Locale.US).format(Date(it))) }
        details.uploadedAt?.let { add("Uploaded at" to it) }
        details.error?.let { add("Error" to it) }
    }
}

private fun photoDetailsRows(details: PhotoPreviewDetails?): List<Pair<String, String>> {
    if (details == null) return listOf("Status" to "No photo metadata received yet")
    return buildList {
        add("Source" to details.source)
        add("State" to details.state)
        details.requestId?.let { add("Request ID" to it) }
        details.byteCount?.let { add("Size" to formatBytes(it)) }
        if (details.width != null && details.height != null) add("Dimensions" to "${details.width} x ${details.height}")
        details.contentType?.let { add("Content type" to it) }
        details.uploadUrl?.let { add("Upload URL" to it) }
        details.previewUrl?.let { add("Preview URL" to it) }
        details.timestamp?.let { add("SDK timestamp" to SimpleDateFormat("HH:mm:ss", Locale.US).format(Date(it))) }
        details.uploadedAt?.let { add("Uploaded at" to it) }
        details.error?.let { add("Error" to it) }
    }
}

private fun formatBytes(bytes: Int): String =
    if (bytes >= 1024 * 1024) {
        String.format(Locale.US, "%.1f MB", bytes / (1024.0 * 1024.0))
    } else {
        "${maxOf(1, (bytes + 1023) / 1024)} KB"
    }

private fun formatDurationMs(ms: Long): String =
    when {
        ms < 1000 -> "$ms ms"
        ms < 60_000 -> String.format(Locale.US, "%.1fs", ms / 1000.0)
        else -> "${ms / 60_000}:${((ms % 60_000) / 1000).toString().padStart(2, '0')}"
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
        normalized.contains("connect the glasses to wi-fi") ||
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
    return "Cloud server setup: run python3 examples/local-demo-cloud/server.py from the Starter Kit repo root, then paste the printed Media upload URL here. It looks like http://<computer-ip>:8787/upload."
}

private fun exposureLabel(ns: Int): String {
    val denominator = (1_000_000_000.0 / ns).toInt()
    return "${"%,d".format(ns)} ns · 1/${denominator}s"
}

@Composable
private fun SliderNudgeButton(label: String, enabled: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (enabled) AppColor.ink else AppColor.muted,
        fontSize = 18.sp,
        fontWeight = FontWeight.ExtraBold,
        modifier = Modifier
            .size(width = 34.dp, height = 34.dp)
            .clip(RoundedCornerShape(999.dp))
            .background(Color.White.copy(alpha = 0.78f))
            .border(1.dp, AppColor.ink.copy(alpha = 0.08f), RoundedCornerShape(999.dp))
            .clickable(enabled = enabled) { onClick() }
            .wrapContentSize(Alignment.Center)
    )
}

@Composable
private fun FixedMediaServerRow() {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(AppColor.ink.copy(alpha = 0.04f))
            .heightIn(min = 44.dp)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(
            "Media cloud server",
            color = AppColor.ink,
            fontSize = 14.sp,
            fontWeight = FontWeight.SemiBold,
        )
        Text(
            "MP4",
            color = AppColor.greenAccent,
            fontSize = 11.sp,
            fontWeight = FontWeight.ExtraBold,
            modifier = Modifier
                .clip(RoundedCornerShape(999.dp))
                .background(AppColor.greenAccent.copy(alpha = 0.14f))
                .padding(horizontal = 10.dp, vertical = 5.dp)
        )
    }
}

@Composable
private fun CloudServerToggle(enabled: Boolean, onEnabledChange: (Boolean) -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(AppColor.ink.copy(alpha = 0.04f))
            .heightIn(min = 44.dp)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(
            "Use media cloud server",
            color = AppColor.ink,
            fontSize = 14.sp,
            fontWeight = FontWeight.SemiBold,
        )
        Switch(checked = enabled, onCheckedChange = onEnabledChange)
    }
}

@Composable
private fun CameraOptionGroup(label: String, content: @Composable RowScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            label.uppercase(),
            color = AppColor.muted,
            fontSize = 12.sp,
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
private fun OptionChip(value: String, active: Boolean, enabled: Boolean = true, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(if (active) AppColor.greenAccent.copy(alpha = 0.16f) else Color.White.copy(alpha = 0.6f))
            .border(
                1.dp,
                if (active) AppColor.greenAccent.copy(alpha = 0.32f) else AppColor.ink.copy(alpha = 0.06f),
                RoundedCornerShape(999.dp)
            )
            .clickable(enabled = enabled) { onClick() }
            .heightIn(min = 44.dp)
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Text(value, color = if (active) AppColor.greenAccent else AppColor.ink, fontSize = 13.sp, fontWeight = FontWeight.Bold, maxLines = 1)
    }
}
