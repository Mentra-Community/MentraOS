package com.mentra.acsmeeting

import com.azure.android.communication.calling.AdmitParticipantsResult
import com.azure.android.communication.calling.Call
import com.azure.android.communication.calling.CallLobby
import com.azure.android.communication.calling.CallState
import com.azure.android.communication.calling.ParticipantState
import com.azure.android.communication.calling.RemoteParticipant
import com.azure.android.communication.common.CommunicationUserIdentifier
import java9.util.concurrent.CompletableFuture
import org.assertj.core.api.Assertions.assertThat
import org.junit.Test
import org.mockito.Mockito.*

class LobbyAdmissionTest {
  private class Harness {
    val call = mock(Call::class.java)
    val lobby = mock(CallLobby::class.java)
    val guest = mock(RemoteParticipant::class.java)
    val id = CommunicationUserIdentifier("8:acs:guest")
    val pending = CompletableFuture<AdmitParticipantsResult>()
    var current = true
    var completed = false
    var failure: Throwable? = null
    init {
      `when`(call.state).thenReturn(CallState.CONNECTED)
      `when`(call.callLobby).thenReturn(lobby)
      `when`(guest.identifier).thenReturn(id)
      `when`(guest.state).thenReturn(ParticipantState.IN_LOBBY)
      `when`(call.remoteParticipants).thenReturn(listOf(guest))
      `when`(lobby.participants).thenReturn(emptyList())
      `when`(lobby.admit(listOf(id))).thenReturn(pending)
    }
    fun start(allowed: Boolean = true, selected: String = id.rawId) {
      admitLobbyParticipant(call, selected, allowed, { current }, { it() }) {
        completed = true
        failure = it
      }
    }
    fun succeed(count: Int = 1, failures: List<RemoteParticipant> = emptyList()) {
      val result = mock(AdmitParticipantsResult::class.java)
      `when`(result.successCount).thenReturn(count)
      `when`(result.failedParticipants).thenReturn(failures)
      pending.complete(result)
    }
  }

  @Test fun deniesAdmissionWithoutCapability() {
    val h = Harness()
    h.start(allowed = false)
    assertThat(h.failure).hasMessageContaining("does not allow")
    verify(h.lobby, never()).admit(anyList())
  }

  @Test fun refusesMissingOrAlreadyAdmittedGuest() {
    for (missing in listOf(true, false)) {
      val h = Harness()
      if (!missing) `when`(h.guest.state).thenReturn(ParticipantState.CONNECTED)
      h.start(selected = if (missing) "some-other-guest" else h.id.rawId)
      assertThat(h.failure).hasMessageContaining("no longer waiting")
      verify(h.lobby, never()).admit(anyList())
    }
  }

  @Test fun admitsSelectedRosterGuestWhenSeparateLobbyCollectionIsEmpty() {
    val h = Harness()
    val other = mock(RemoteParticipant::class.java)
    `when`(other.identifier).thenReturn(CommunicationUserIdentifier("8:acs:other-guest"))
    `when`(other.state).thenReturn(ParticipantState.IN_LOBBY)
    `when`(h.call.remoteParticipants).thenReturn(listOf(other, h.guest))
    h.start()
    assertThat(h.completed).isFalse()
    verify(h.lobby).admit(listOf(h.id))
    verify(h.lobby, never()).admitAll()
    h.succeed()
    assertThat(h.completed).isTrue()
    assertThat(h.failure).isNull()
  }

  @Test fun rejectsIncompleteAndFailedAdmissionResults() {
    for (count in listOf(0, 1)) {
      val h = Harness()
      h.start()
      h.succeed(count, if (count == 1) listOf(h.guest) else emptyList())
      assertThat(h.failure).hasMessageContaining("did not admit")
    }
  }

  @Test fun refusesWorkQueuedBeforeLeave() {
    val h = Harness()
    h.current = false
    h.start()
    assertThat(h.failure).hasMessageContaining("No connected meeting")
    verify(h.lobby, never()).admit(anyList())
  }

  @Test fun rejectsLateSuccessAfterMeetingChanges() {
    val h = Harness()
    h.start()
    h.current = false
    h.succeed()
    assertThat(h.failure).hasMessageContaining("meeting changed")
  }

  @Test fun propagatesAcsFailure() {
    val h = Harness()
    h.start()
    val error = IllegalStateException("ACS refused")
    h.pending.completeExceptionally(error)
    assertThat(h.failure).isSameAs(error)
  }
}
