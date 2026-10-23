package com.mentra.bluetoothsdk.sgcs
import org.json.JSONObject
import android.os.Process
import android.os.SystemClock
internal object NimoResourceDiagnostics {
 internal fun preArmCaptureRequired(buildType: String = "nimoDiagnostic"): Boolean = buildType == "nimoDiagnostic"
 internal fun allowUnarmedWearable(buildType: String, wearable: String): Boolean = !preArmCaptureRequired(buildType) || !wearable.contains("NIMO", ignoreCase=true)
 fun allowManagerConnect(wearable:String,name:String?=null):Boolean = allowUnarmedWearable("nimoDiagnostic",wearable)
 fun admit():Boolean = !preArmCaptureRequired()

 const val CLOCK_PROTOCOL="nimo-monotonic-receipt-v1"
 private val processInstanceId="sample"
 private data class Capture(val nonce:String,val name:String,val address:String,var instance:Nimo?=null,var cancelled:Boolean=false,var connectStarted:Boolean=false,var transportStarted:Boolean=false,val armedElapsedMs:Long,var admittedElapsedMs:Long?=null)
    private fun captureSnapshot(owned: Capture, admittedElapsedMs: Long? = owned.admittedElapsedMs): JSONObject = JSONObject()
        .put("clockProtocol", CLOCK_PROTOCOL)
        .put("clock", JSONObject().put("kind", "android-elapsed-realtime-v1").put("armedElapsedMs", owned.armedElapsedMs)
            .put("admittedElapsedMs", admittedElapsedMs ?: JSONObject.NULL).put("observedElapsedMs", SystemClock.elapsedRealtime()))
        .put("version", "nimo-preconnect-capture-v1").put("nonce", owned.nonce)
        .put("captureRequiredBeforeArm", preArmCaptureRequired())
        .put("expectedPair", JSONObject().put("name", owned.name).put("bluetoothAddress", owned.address))
        .put("instanceId", owned.instance?.resourceInstanceId ?: JSONObject.NULL)
        .put("sessionGeneration", owned.instance?.resourceSnapshot()?.getLong("sessionGeneration") ?: JSONObject.NULL)
        .put("observedPair", if (owned.transportStarted) owned.instance?.resourceSnapshot()?.getJSONObject("pair") ?: JSONObject.NULL else JSONObject.NULL)
        .put("cancelled", owned.cancelled).put("connectStarted", owned.connectStarted)
        .put("transportStarted", owned.transportStarted)
        .put("appPid", Process.myPid()).put("processInstanceId", processInstanceId)
        .put("observedAtEpochMs", System.currentTimeMillis())
}
class Nimo { val resourceInstanceId="sample"; fun resourceSnapshot()=JSONObject() }
