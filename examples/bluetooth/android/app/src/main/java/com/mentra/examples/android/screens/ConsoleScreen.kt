package com.mentra.examples.android.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material3.Icon
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mentra.examples.android.ExampleEvent
import com.mentra.examples.android.MentraExampleController
import com.mentra.examples.android.isGlassesConnected
import com.mentra.examples.android.ui.AppColor
import com.mentra.examples.android.ui.PageHeader
import com.mentra.examples.android.ui.scrollBottomPadding

@Composable
fun ConsoleScreen(controller: MentraExampleController) {
    val state = controller.state
    var filter by remember { mutableStateOf("ALL") }
    val allEvents = state.events
    val events = if (filter == "ALL") allEvents else allEvents.filter { it.tag == filter }
    Column(modifier = Modifier.fillMaxSize().background(AppColor.bg).verticalScroll(rememberScrollState())) {
        PageHeader("Console")

        // Filter chips
        Row(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp).horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            Row(
                modifier = Modifier.clip(RoundedCornerShape(999.dp))
                    .background(Brush.verticalGradient(listOf(Color(0xFF28473A), Color(0xFF1F3A2A))))
                    .clickable { filter = "ALL" }
                    .padding(horizontal = 12.dp, vertical = 7.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                Text("ALL", color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.5.sp)
                Text(allEvents.size.toString(), color = Color.White.copy(alpha = 0.5f), fontSize = 10.sp, fontWeight = FontWeight.Medium)
            }
            FilterChip(Color(0xFF00C7BE), Color(0xFF00807B), "LIVE", allEvents.count { it.tag == "LIVE" }.toString(), filter == "LIVE") { filter = "LIVE" }
            FilterChip(Color(0xFF84B5E8), Color(0xFF3478B8), "BLE", allEvents.count { it.tag == "BLE" }.toString(), filter == "BLE") { filter = "BLE" }
            FilterChip(AppColor.amber, Color(0xFFB86A00), "TX", allEvents.count { it.tag == "TX" }.toString(), filter == "TX") { filter = "TX" }
            FilterChip(AppColor.gold, Color(0xFF8C7400), "STORE", allEvents.count { it.tag == "STORE" }.toString(), filter == "STORE") { filter = "STORE" }
        }

        // Console card
        Column(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)
                .clip(RoundedCornerShape(24.dp))
                .background(AppColor.consoleBg)
                .border(1.dp, Color.White.copy(alpha = 0.06f), RoundedCornerShape(24.dp))
                .padding(18.dp)
        ) {
            Row(modifier = Modifier.fillMaxWidth().padding(bottom = 6.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        Box(modifier = Modifier.size(8.dp).clip(CircleShape).background(Color(0xFFFF5F57)))
                        Box(modifier = Modifier.size(8.dp).clip(CircleShape).background(Color(0xFFFEBC2E)))
                        Box(modifier = Modifier.size(8.dp).clip(CircleShape).background(Color(0xFF27C93F)))
                    }
                    Text("mentra-sdk · live", color = Color.White.copy(alpha = 0.5f), fontSize = 11.sp, fontWeight = FontWeight.Medium)
                }
                Row(
                    modifier = Modifier.clip(RoundedCornerShape(999.dp)).background(AppColor.greenSoft.copy(alpha = 0.14f))
                        .border(1.dp, AppColor.greenSoft.copy(alpha = 0.3f), RoundedCornerShape(999.dp))
                        .padding(horizontal = 9.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(5.dp)
                ) {
                    Box(modifier = Modifier.size(5.dp).clip(CircleShape).background(AppColor.greenSoft))
                    Text("REC", color = AppColor.greenSoft, fontSize = 9.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.7.sp)
                }
            }
            Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(Color.White.copy(alpha = 0.06f)))
            Spacer(Modifier.height(12.dp))
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                events.forEach { e ->
                    val tagColor = tagColor(e)
                    Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(
                            e.time,
                            color = Color.White.copy(alpha = 0.4f),
                            fontSize = 10.sp,
                            fontWeight = FontWeight.Medium,
                            fontFamily = FontFamily.Monospace,
                            modifier = Modifier.width(50.dp).padding(top = 2.dp)
                        )
                        Box(
                            modifier = Modifier.width(50.dp).clip(RoundedCornerShape(5.dp)).background(tagColor.copy(alpha = 0.16f)).padding(vertical = 3.dp),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(e.tag, color = tagColor, fontSize = 9.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.5.sp)
                        }
                        Text(e.text, color = AppColor.consoleText, fontSize = 11.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f))
                    }
                }
            }
        }

        // Raw JSON disclosure
        Row(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp).fillMaxWidth()
                .clip(RoundedCornerShape(18.dp))
                .background(Color.White.copy(alpha = 0.6f))
                .border(1.dp, AppColor.borderSoft, RoundedCornerShape(18.dp))
                .clickable { controller.toggleRawJson() }
                .padding(horizontal = 16.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Icon(Icons.Outlined.Code, null, tint = AppColor.muted, modifier = Modifier.size(14.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text("Typed SDK status", color = AppColor.ink, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                Text("glassesStatus, bluetoothStatus", color = AppColor.muted, fontSize = 10.sp)
            }
            Icon(Icons.Outlined.KeyboardArrowDown, null, tint = AppColor.ink, modifier = Modifier.size(14.dp))
        }

        if (state.rawJsonExpanded) {
            Text(
                "glassesStatus=${state.glassesStatus}\nbluetoothStatus=${state.bluetoothStatus}",
                color = AppColor.consoleText,
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
                    .clip(RoundedCornerShape(14.dp))
                    .background(AppColor.consoleBg)
                    .padding(12.dp)
            )
        }

        Spacer(Modifier.height(scrollBottomPadding()))
    }
}

private fun tagColor(event: ExampleEvent): Color =
    when (event.tag) {
        "BLE" -> Color(0xFF84B5E8)
        "STORE" -> Color(0xFFE8C66B)
        "TX" -> Color(0xFFE89C7D)
        else -> Color(0xFF7DD89E)
    }

@Composable
private fun FilterChip(dot: Color, labelColor: Color, label: String, count: String, active: Boolean, onClick: () -> Unit) {
    Row(
        modifier = Modifier.clip(RoundedCornerShape(999.dp))
            .background(if (active) dot.copy(alpha = 0.14f) else Color.White.copy(alpha = 0.6f))
            .border(1.dp, if (active) dot.copy(alpha = 0.35f) else AppColor.border, RoundedCornerShape(999.dp))
            .clickable { onClick() }
            .padding(horizontal = 12.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Box(modifier = Modifier.size(6.dp).clip(CircleShape).background(dot))
        Text(label, color = labelColor, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.5.sp)
        Text(count, color = AppColor.muted, fontSize = 10.sp, fontWeight = FontWeight.Medium)
    }
}
