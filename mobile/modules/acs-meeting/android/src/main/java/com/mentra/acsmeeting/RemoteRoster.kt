package com.mentra.acsmeeting

import android.util.Log
import com.azure.android.communication.calling.Call
import com.azure.android.communication.calling.ParticipantState
import com.azure.android.communication.calling.ParticipantsUpdatedListener
import com.azure.android.communication.calling.PropertyChangedListener
import com.azure.android.communication.calling.RemoteParticipant
import java.util.concurrent.ConcurrentHashMap

/**
 * Tracks ACS remote participants so the host can show who is in the room.
 * Listener callbacks arrive on ACS threads; [onChanged] must hop to the
 * session executor before touching session state.
 */
class RemoteRoster(
  private val onChanged: () -> Unit,
) {
  private class Tracked(
    val participant: RemoteParticipant,
    val listener: PropertyChangedListener,
  )

  private var call: Call? = null
  private var updatedListener: ParticipantsUpdatedListener? = null
  private val tracked = ConcurrentHashMap<String, Tracked>()

  fun attach(joined: Call) {
    detach()
    call = joined
    val listener = ParticipantsUpdatedListener { event ->
      event.addedParticipants.forEach { track(it) }
      event.removedParticipants.forEach { untrack(it) }
      Log.i(TAG, "roster updated added=${event.addedParticipants.size} removed=${event.removedParticipants.size} size=${tracked.size}")
      onChanged()
    }
    joined.addOnRemoteParticipantsUpdatedListener(listener)
    updatedListener = listener
    joined.remoteParticipants.forEach { track(it) }
    Log.i(TAG, "roster attached size=${tracked.size}")
  }

  fun detach() {
    val joined = call
    val listener = updatedListener
    call = null
    updatedListener = null
    if (joined != null && listener != null) {
      try {
        joined.removeOnRemoteParticipantsUpdatedListener(listener)
      } catch (_: Exception) {
      }
    }
    tracked.values.forEach { removeListeners(it) }
    tracked.clear()
  }

  fun snapshot(): List<Map<String, Any?>> =
    tracked.values
      .map { describe(it.participant) }
      .sortedBy { it["id"] as? String ?: "" }

  private fun track(participant: RemoteParticipant) {
    val id = idOf(participant)
    if (tracked.containsKey(id)) return
    val listener = PropertyChangedListener { onChanged() }
    val entry = Tracked(participant, listener)
    tracked[id] = entry
    try {
      participant.addOnStateChangedListener(listener)
      participant.addOnIsMutedChangedListener(listener)
      participant.addOnIsSpeakingChangedListener(listener)
      participant.addOnDisplayNameChangedListener(listener)
    } catch (error: Exception) {
      Log.w(TAG, "roster listener attach failed", error)
    }
  }

  private fun untrack(participant: RemoteParticipant) {
    tracked.remove(idOf(participant))?.let { removeListeners(it) }
  }

  private fun removeListeners(entry: Tracked) {
    try {
      entry.participant.removeOnStateChangedListener(entry.listener)
      entry.participant.removeOnIsMutedChangedListener(entry.listener)
      entry.participant.removeOnIsSpeakingChangedListener(entry.listener)
      entry.participant.removeOnDisplayNameChangedListener(entry.listener)
    } catch (_: Exception) {
    }
  }

  companion object {
    private const val TAG = "ACS-SPIKE"

    fun idOf(participant: RemoteParticipant): String =
      try {
        participant.identifier?.rawId ?: "participant-${System.identityHashCode(participant)}"
      } catch (_: Exception) {
        "participant-${System.identityHashCode(participant)}"
      }

    fun describe(participant: RemoteParticipant): Map<String, Any?> {
      val state = try { participant.state } catch (_: Exception) { null }
      return mapOf(
        "id" to idOf(participant),
        "displayName" to (try { participant.displayName } catch (_: Exception) { null }),
        "state" to stateName(state),
        "isMuted" to (try { participant.isMuted } catch (_: Exception) { false }),
        "isSpeaking" to (try { participant.isSpeaking } catch (_: Exception) { false }),
      )
    }

    fun stateName(state: ParticipantState?): String = when (state) {
      ParticipantState.CONNECTED -> "connected"
      ParticipantState.CONNECTING, ParticipantState.RINGING, ParticipantState.EARLY_MEDIA -> "connecting"
      ParticipantState.IN_LOBBY -> "lobby"
      ParticipantState.HOLD -> "hold"
      ParticipantState.DISCONNECTED -> "disconnected"
      ParticipantState.IDLE, null -> "idle"
    }
  }
}
