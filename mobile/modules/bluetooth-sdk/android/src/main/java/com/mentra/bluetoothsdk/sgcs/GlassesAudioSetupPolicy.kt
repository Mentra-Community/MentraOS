package com.mentra.bluetoothsdk.sgcs

/**
 * `GlassesStatus.audioSetup`: whether the user has to do anything to get glasses audio working.
 * Native code encodes it as a map, `{"state": "idle"}` through
 * `{"state": "needs_user", "action": "connect_in_settings"}`, the same shape as the TypeScript
 * `GlassesAudioSetupState` and iOS.
 */
internal enum class GlassesAudioSetupState(val state: String, val action: String? = null) {
    /** No glasses session. */
    IDLE("idle"),
    /** No user step for audio on this platform and glasses. */
    NOT_APPLICABLE("not_applicable"),
    /** The link is up, audio is not, and the SDK still expects audio to come up on its own. */
    CONNECTING("connecting"),
    /** Classic audio to these glasses is up. */
    CONNECTED("connected"),
    /** Audio did not come up on its own. The user connects it in system Bluetooth settings. */
    NEEDS_USER("needs_user", "connect_in_settings");

    fun toMap(): Map<String, Any> =
            if (action == null) mapOf("state" to state) else mapOf("state" to state, "action" to action)

    companion object {
        fun fromMap(raw: Any?): GlassesAudioSetupState? {
            val state = (raw as? Map<*, *>)?.get("state") as? String ?: return null
            return values().firstOrNull { it.state == state }
        }
    }
}

/**
 * The Android audio setup rule, for every glasses model including Mentra Live. Android attaches
 * Classic audio from the BLE bond (CTKD on secure Mentra Live firmware, `createBond` on older
 * firmware), and glasses without Classic audio have nothing to set up, so there is never a user
 * step to offer: `not_applicable` while the glasses are ready, `idle` without a session. The
 * shared status layer applies it, so the update that marks the glasses ready carries
 * `not_applicable` with it. iOS keeps its timed Mentra Live rules in `GlassesAudioSetupPolicy.swift`.
 */
internal object GlassesAudioSetupPolicy {
    fun state(ready: Boolean): GlassesAudioSetupState =
            if (ready) GlassesAudioSetupState.NOT_APPLICABLE else GlassesAudioSetupState.IDLE

    /** The state `audio_setup_changed` announces when readiness moves, or null when it is unchanged. */
    fun change(wasReady: Boolean, ready: Boolean): GlassesAudioSetupState? {
        val after = state(ready)
        return if (state(wasReady) == after) null else after
    }
}

/**
 * Mentra Live firmware `{"type":"classic_link","a2dp":<bool>,"hfp":<bool>}`: whether the phone's
 * A2DP and HFP (service-level) links to the glasses are up. iOS feeds it into its audio setup
 * rules; Android's `audioSetup` does not depend on it. A missing or malformed field reads false.
 */
internal data class MentraLiveClassicLink(val a2dp: Boolean, val hfp: Boolean) {
    companion object {
        fun parse(json: org.json.JSONObject): MentraLiveClassicLink =
                MentraLiveClassicLink(
                        a2dp = json.optBoolean("a2dp", false),
                        hfp = json.optBoolean("hfp", false),
                )
    }
}
