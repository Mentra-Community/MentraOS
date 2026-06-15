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
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
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
import com.mentra.examples.android.cameraRoiPositions
import com.mentra.examples.android.cameraSdkCall
import com.mentra.examples.android.isGlassesConnected
import com.mentra.examples.android.isGlassesWifiConnected
import com.mentra.examples.android.photoCompressionOptions
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

@Composable
fun CameraScreen(controller: MentraExampleController) {
    val state = controller.state
    val connected = isGlassesConnected(state.glassesStatus)
    val glassesWifiConnected = isGlassesWifiConnected(state.glassesStatus)
    val wifiRequired = connected && !glassesWifiConnected
    val cloudServerEnabled = state.photoDestination == PhotoDestination.MACBOOK_SERVER
    val directPhone = !cloudServerEnabled
    val cameraStatusFailed = isCameraStatusFailure(state.cameraStatus)
    val setupHint = if (cloudServerEnabled) localCameraSetupHint(state.webhookUrl, state.cameraStatus) else null
    val sdkCall = cameraSdkCall(
        state.photoSize,
        state.photoCompression,
        state.photoExposureManual,
        state.photoExposureTimeNs,
        state.photoIso,
        state.cameraFov,
        state.cameraRoiPosition,
        state.scanMode,
        state.scanAeDivisor,
        state.scanIsoCap,
    )
    val clipboardManager = LocalClipboardManager.current
    var photoDetailsExpanded by remember { mutableStateOf(false) }
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
                        } else if (state.activeAction == "Capture & upload") {
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
            Box(Modifier.padding(horizontal = 6.dp)) {
                ScanModeSettingsCard(controller)
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
                        when {
                            state.photoPreviewUrl != null && directPhone -> "Preview loaded from phone receiver"
                            state.photoPreviewUrl != null -> "Preview loaded from cloud server"
                            directPhone && state.phonePhotoServerRunning -> "Phone receiver ready"
                            directPhone -> "Phone receiver starts on capture"
                            else -> "Waiting for capture"
                        },
                        color = AppColor.muted,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Medium
                    )
                }
            }
        }

        PhotoDetailsCard(
            details = state.photoPreviewDetails,
            expanded = photoDetailsExpanded,
            onToggle = { photoDetailsExpanded = !photoDetailsExpanded },
        )

        // Upload card
        GlassCard(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            corner = 22,
            padding = PaddingValues(horizontal = 18.dp, vertical = 16.dp)
        ) {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Eyebrow("UPLOAD TO")
                if (cloudServerEnabled) {
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
            CloudServerToggle(
                enabled = cloudServerEnabled,
                onEnabledChange = { enabled ->
                    controller.setPhotoDestination(if (enabled) PhotoDestination.MACBOOK_SERVER else PhotoDestination.THIS_PHONE)
                },
            )
            Spacer(Modifier.height(12.dp))
            if (cloudServerEnabled) {
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
                                Text("Photo upload URL", color = AppColor.muted, fontSize = 13.sp)
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
                CameraOptionGroup("size") {
                    photoSizeOptions.forEach { size ->
                        OptionChip(
                            size,
                            !state.scanMode && state.photoSize == size,
                            enabled = !state.scanMode,
                        ) { controller.setPhotoSize(size) }
                    }
                }
                CameraOptionGroup("compress") {
                    photoCompressionOptions.forEach { compression ->
                        OptionChip(compression, state.photoCompression == compression) {
                            controller.setPhotoCompression(compression)
                        }
                    }
                }
                ExposureSettingsCard(controller)
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
                    if (state.scanMode) "Document / barcode capture preset" else "Standard photo capture",
                    color = AppColor.greenAccent,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                )
            }
            Switch(checked = state.scanMode, onCheckedChange = controller::setScanMode)
        }
        if (state.scanMode) {
            Text(
                "Pushes size, MFNR, NR, edge, and ISP gain presets to glasses (HAL may warn not_implemented). AE÷${state.scanAeDivisor} and ISO cap ${state.scanIsoCap} still ship on capture.",
                color = AppColor.muted,
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
            )
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OptionChip("AE ÷3", state.scanAeDivisor == 3) { controller.setScanAeDivisor(3) }
                OptionChip("AE ÷5", state.scanAeDivisor == 5) { controller.setScanAeDivisor(5) }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OptionChip("ISO 800", state.scanIsoCap == 800) { controller.setScanIsoCap(800) }
                OptionChip("ISO 400", state.scanIsoCap == 400) { controller.setScanIsoCap(400) }
            }
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
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            SliderNudgeButton("-", enabled = state.photoExposureManual && state.photoExposureTimeNs > PHOTO_EXPOSURE_MIN_NS) {
                controller.setPhotoExposureTimeNs(state.photoExposureTimeNs - 500_000)
            }
            Slider(
                enabled = state.photoExposureManual,
                value = state.photoExposureTimeNs.toFloat(),
                onValueChange = { controller.setPhotoExposureTimeNs((it / 500_000f).roundToInt() * 500_000) },
                valueRange = PHOTO_EXPOSURE_MIN_NS.toFloat()..PHOTO_EXPOSURE_MAX_NS.toFloat(),
                modifier = Modifier.weight(1f),
            )
            SliderNudgeButton("+", enabled = state.photoExposureManual && state.photoExposureTimeNs < PHOTO_EXPOSURE_MAX_NS) {
                controller.setPhotoExposureTimeNs(state.photoExposureTimeNs + 500_000)
            }
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            Text("1/1000s", color = AppColor.muted, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
            Text(
                "Default 1/120s",
                color = AppColor.greenAccent,
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.clickable { controller.setPhotoExposureTimeNs(PHOTO_EXPOSURE_DEFAULT_NS) }
            )
            Text("1/30s", color = AppColor.muted, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
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
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            SliderNudgeButton("-", enabled = state.photoExposureManual && state.photoIso > PHOTO_ISO_MIN) {
                controller.setPhotoIso(state.photoIso - 50)
            }
            Slider(
                enabled = state.photoExposureManual,
                value = state.photoIso.toFloat(),
                onValueChange = { controller.setPhotoIso((it / 50f).roundToInt() * 50) },
                valueRange = PHOTO_ISO_MIN.toFloat()..PHOTO_ISO_MAX.toFloat(),
                modifier = Modifier.weight(1f),
            )
            SliderNudgeButton("+", enabled = state.photoExposureManual && state.photoIso < PHOTO_ISO_MAX) {
                controller.setPhotoIso(state.photoIso + 50)
            }
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            Text("ISO $PHOTO_ISO_MIN", color = AppColor.muted, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
            Text(
                "Default ISO $PHOTO_ISO_DEFAULT",
                color = AppColor.greenAccent,
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.clickable { controller.setPhotoIso(PHOTO_ISO_DEFAULT) }
            )
            Text("ISO $PHOTO_ISO_MAX", color = AppColor.muted, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
        }
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
                "Default ${CAMERA_FOV_DEFAULT}°",
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
private fun PhotoDetailsCard(details: PhotoPreviewDetails?, expanded: Boolean, onToggle: () -> Unit) {
    GlassCard(
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
        corner = 18,
        padding = PaddingValues(horizontal = 14.dp, vertical = 12.dp)
    ) {
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
    return "Cloud server setup: run python3 examples/local-demo-cloud/server.py from the Starter Kit repo root, then paste the printed Photo upload URL here. It looks like http://<computer-ip>:8787/upload."
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
            "Use cloud server",
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
