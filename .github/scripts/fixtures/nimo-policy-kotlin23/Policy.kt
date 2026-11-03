package com.mentra.bluetoothsdk.sgcs
internal object NimoResourceDiagnostics {
 internal fun preArmCaptureRequired(buildType: String = "nimoDiagnostic"): Boolean = buildType == "nimoDiagnostic"
 internal fun allowUnarmedWearable(buildType: String, wearable: String): Boolean = !preArmCaptureRequired(buildType) || !wearable.contains("NIMO", ignoreCase=true)
 fun allowManagerConnect(wearable:String,name:String?=null):Boolean = allowUnarmedWearable("nimoDiagnostic",wearable)
 fun admit():Boolean = !preArmCaptureRequired()
}
