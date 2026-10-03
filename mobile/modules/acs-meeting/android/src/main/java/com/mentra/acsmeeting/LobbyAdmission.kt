package com.mentra.acsmeeting

import com.azure.android.communication.calling.CommonCall
import com.azure.android.communication.calling.CallState
import com.azure.android.communication.calling.ParticipantState

/** Admit one current lobby guest without blocking the session executor or changing meeting policy. */
internal fun admitLobbyParticipant(
  active: CommonCall,
  participantId: String,
  allowed: Boolean,
  isCurrent: () -> Boolean,
  dispatch: (() -> Unit) -> Unit,
  complete: (Throwable?) -> Unit,
) {
  try {
    check(isCurrent() && active.state == CallState.CONNECTED) { "No connected meeting" }
    check(allowed) { "This meeting does not allow you to admit guests" }
    // Resolve the selected guest against the same live roster that supplies the UI.
    val guest = active.remoteParticipants.firstOrNull {
      it.identifier.rawId == participantId && it.state == ParticipantState.IN_LOBBY
    } ?: throw IllegalStateException("This guest is no longer waiting in the lobby")
    active.callLobby.admit(listOf(guest.identifier)).whenComplete { result, error ->
      dispatch {
        val failure = when {
          !isCurrent() -> IllegalStateException("The meeting changed before admission completed")
          error != null -> error
          result?.successCount != 1 || result.failedParticipants.isNotEmpty() ->
            IllegalStateException("Teams did not admit this guest")
          else -> null
        }
        complete(failure)
      }
    }
  } catch (error: Exception) {
    complete(error)
  }
}
