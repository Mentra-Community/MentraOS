package com.mentra.examples.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object AppColor {
    val bg = Color.White
    val ink = Color(0xFF0E1A14)
    val inkAlt = Color(0xFF0E0E10)
    val muted = Color(0xFF6B7268)
    val mutedSoft = Color(0xFF9DA29A)
    val greenPrimary = Color(0xFF16A34A)
    val greenAccent = Color(0xFF34C759)
    val greenInk = Color(0xFF0E2C1A)
    val greenSoft = Color(0xFF7DD89E)
    val greenDeep = Color(0xFF248A3D)
    val red = Color(0xFFFF3B30)
    val redLive = Color(0xFFFF5252)
    val amber = Color(0xFFFF9500)
    val gold = Color(0xFFFFCC00)
    val ble = Color(0xFF84B5E8)
    val store = Color(0xFFE8C66B)
    val tx = Color(0xFFE89C7D)
    val consoleBg = Color(0xEB141615)
    val consoleText = Color(0xFFE8E2CE)
    val border = Color(0xBFFFFFFF)
    val borderSoft = Color(0xB3FFFFFF)
    val hairline = Color(0x140F2A1D)
}

@Composable
fun GlassCard(
    modifier: Modifier = Modifier,
    corner: Int = 28,
    padding: PaddingValues = PaddingValues(22.dp),
    content: @Composable () -> Unit
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(corner.dp))
            .background(
                Brush.verticalGradient(
                    listOf(Color(0xC7FFFFFF), Color(0x8CFFFFFF))
                )
            )
            .border(1.dp, AppColor.border, RoundedCornerShape(corner.dp))
            .padding(padding)
    ) {
        content()
    }
}

@Composable
fun Eyebrow(text: String, color: Color = AppColor.muted, mono: Boolean = false) {
    Text(
        text = text,
        color = color,
        fontWeight = FontWeight.SemiBold,
        fontSize = 10.sp,
        letterSpacing = if (mono) 1.6.sp else 1.2.sp,
        fontFamily = if (mono) FontFamily.Monospace else FontFamily.SansSerif
    )
}

@Composable
fun StatusBarRow(modifier: Modifier = Modifier) {
    var time by remember { mutableStateOf(currentStatusTime()) }

    LaunchedEffect(Unit) {
        while (true) {
            delay(30_000)
            time = currentStatusTime()
        }
    }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 24.dp)
            .padding(top = 21.dp, bottom = 19.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(time, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = Color.Black)
        Text("● ◐ ▮", fontSize = 12.sp, color = Color.Black)
    }
}

private fun currentStatusTime(): String =
    SimpleDateFormat("h:mm", Locale.US).format(Date())
