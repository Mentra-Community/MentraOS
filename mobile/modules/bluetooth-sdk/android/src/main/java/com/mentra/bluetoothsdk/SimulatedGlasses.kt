package com.mentra.bluetoothsdk

/** Kind of a recorded simulated display command. */
enum class SimulatedDisplayEventKind {
    CLEAR,
    TEXT,
    TEXT_WALL,
    DOUBLE_TEXT_WALL,
    BITMAP,
}

/** One display command in call order, as the simulated glasses would have rendered it. */
data class SimulatedDisplayEvent(
    val kind: SimulatedDisplayEventKind,
    val text: String? = null,
    val top: String? = null,
    val bottom: String? = null,
    val base64ImageData: String? = null,
)

/**
 * Scriptable handle for the built-in simulated glasses.
 *
 * [MentraBluetoothSdk.connectSimulated] returns this handle after connecting the simulated device.
 * Injected events flow through the same [Bridge] event sinks as real hardware events, so listeners
 * observe [MentraBluetoothSdkListener.onMicPcm], [MentraBluetoothSdkListener.onTouch],
 * [MentraBluetoothSdkListener.onSwipe], and [MentraBluetoothSdkListener.onHeadUpChanged] exactly as
 * they would for a physical pair.
 */
interface SimulatedGlasses {
    /** Display commands recorded since the last [clearDisplayTranscript], in call order. */
    fun displayTranscript(): List<SimulatedDisplayEvent>

    fun clearDisplayTranscript()

    /** Deliver a PCM frame tagged with `source = "glasses"`. */
    fun injectMicPcm(pcm: ByteArray)

    fun injectTouch(gesture: TouchGesture)

    fun injectHeadUp(headUp: Boolean)

    /** Flip the observable connection state to disconnected without tearing down this handle. */
    fun simulateDisconnect()

    fun simulateReconnect()
}
