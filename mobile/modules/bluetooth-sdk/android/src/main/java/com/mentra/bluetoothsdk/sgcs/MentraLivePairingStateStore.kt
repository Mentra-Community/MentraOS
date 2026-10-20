package com.mentra.bluetoothsdk.sgcs

import android.content.Context
import androidx.annotation.VisibleForTesting
import com.mentra.bluetoothsdk.Bridge
import com.mentra.bluetoothsdk.DeviceStore

/**
 * Process-wide owner of the [MentraLivePairingStateMachine]. It outlives each [MentraLive]
 * instance so a disconnect or SGC replacement keeps the pause and the rejection, persists the
 * record natively (never through the replayed settings), and publishes
 * `GlassesStatus.pairingState` plus `pairing_state_changed`.
 */
internal object MentraLivePairingStateStore {
    private const val PREFS = "mentra_live_owner"

    private var machine = MentraLivePairingStateMachine()
    private var restored = false

    /** Drops the in-memory state as a process restart would. Persisted values stay. */
    @VisibleForTesting
    @Synchronized
    internal fun resetForTest() {
        machine = MentraLivePairingStateMachine()
        restored = false
    }

    val state: MentraLivePairingState
        @Synchronized get() = machine.state

    val allowsAutomaticReconnect: Boolean
        @Synchronized get() = machine.allowsAutomaticReconnect

    val isPaused: Boolean
        @Synchronized get() = machine.isPaused

    val isRejected: Boolean
        @Synchronized get() = machine.state == MentraLivePairingState.Rejected

    val verificationArmed: Boolean
        @Synchronized get() = machine.verificationArmed

    /** A window this phone paused for ended and its advertisement has not been read yet. */
    val awaitingTakeoverCheck: Boolean
        @Synchronized get() = machine.awaitingTakeoverCheck

    @Synchronized
    fun remainingPauseMs(nowMs: Long = System.currentTimeMillis()): Long = machine.remainingPauseMs(nowMs)

    /** Restore once per process. Later calls only republish. */
    @Synchronized
    fun ensureRestored(savedDeviceId: String, nowMs: Long = System.currentTimeMillis()): MentraLivePairingTransition? {
        if (restored) {
            publish(emitEvent = false)
            return null
        }
        restored = true
        val prefs = prefs()
        val values = prefs?.all ?: emptyMap<String, Any?>()
        val transition = machine.restore(values, savedDeviceId, nowMs)
        prefs?.edit()?.apply {
            MentraLivePairingStateMachine.LEGACY_KEYS.forEach { remove(it) }
            apply()
        }
        persist()
        publish()
        Bridge.log("PAIRFLOW: pairing_state restore note=${transition.note} state=${describe()}")
        return transition
    }

    /** Run one machine input, persist the record, and publish when the public state changed. */
    @Synchronized
    fun update(
            source: String,
            input: (MentraLivePairingStateMachine) -> MentraLivePairingTransition,
    ): MentraLivePairingTransition {
        val before = machine.state
        val beforeRecord = machine.persisted()
        val transition = input(machine)
        // Duplicate-reporting scans feed every advertisement through here.
        if (machine.persisted() != beforeRecord) persist()
        if (machine.state != before) publish()
        if (transition.effect != MentraLivePairingEffect.NONE || machine.state != before) {
            Bridge.log(
                    "PAIRFLOW: pairing_state source=$source effect=${transition.effect} " +
                            "note=${transition.note} state=${describe()}"
            )
        }
        return transition
    }

    @Synchronized
    fun describe(): String =
            when (val current = machine.state) {
                MentraLivePairingState.Normal -> "normal"
                is MentraLivePairingState.PairingMode ->
                        "pairing_mode(window=${current.windowId}, endsAtMs=${current.endsAtMs})"
                MentraLivePairingState.Rejected -> "pairing_rejected"
            }

    private fun persist() {
        val prefs = prefs() ?: return
        val editor = prefs.edit()
        MentraLivePairingStateMachine.KEYS.forEach { editor.remove(it) }
        machine.persisted().forEach { (key, value) ->
            when (value) {
                is Int -> editor.putInt(key, value)
                is Long -> editor.putLong(key, value)
                is String -> editor.putString(key, value)
                is Boolean -> editor.putBoolean(key, value)
            }
        }
        editor.apply()
    }

    private fun publish(emitEvent: Boolean = true) {
        val map = machine.state.toMap()
        DeviceStore.apply("glasses", "pairingState", map)
        if (emitEvent) Bridge.sendTypedMessage("pairing_state_changed", mapOf("state" to map))
    }

    private fun prefs() =
            Bridge.getContext()?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
