package com.mentra.acsmeeting

import com.azure.android.communication.calling.AudioStreamSampleRate
import com.azure.android.communication.calling.ParticipantState
import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class RemoteRosterTest {
  @Test
  fun participantStatesMapToHostVocabulary() {
    assertThat(RemoteRoster.stateName(ParticipantState.CONNECTED)).isEqualTo("connected")
    assertThat(RemoteRoster.stateName(ParticipantState.IN_LOBBY)).isEqualTo("lobby")
    assertThat(RemoteRoster.stateName(ParticipantState.CONNECTING)).isEqualTo("connecting")
    assertThat(RemoteRoster.stateName(ParticipantState.RINGING)).isEqualTo("connecting")
    assertThat(RemoteRoster.stateName(ParticipantState.EARLY_MEDIA)).isEqualTo("connecting")
    assertThat(RemoteRoster.stateName(ParticipantState.HOLD)).isEqualTo("hold")
    assertThat(RemoteRoster.stateName(ParticipantState.DISCONNECTED)).isEqualTo("disconnected")
    assertThat(RemoteRoster.stateName(ParticipantState.IDLE)).isEqualTo("idle")
    assertThat(RemoteRoster.stateName(null)).isEqualTo("idle")
  }

  @Test
  fun emptyRosterSnapshotsToEmptyList() {
    val roster = RemoteRoster {}
    assertThat(roster.snapshot()).isEmpty()
    roster.detach()
    assertThat(roster.snapshot()).isEmpty()
  }

  @Test
  fun acsSampleRatesMapToHz() {
    assertThat(AcsMeetingSession.sampleRateHz(AudioStreamSampleRate.HZ_16000)).isEqualTo(16000)
    assertThat(AcsMeetingSession.sampleRateHz(AudioStreamSampleRate.HZ_22050)).isEqualTo(22050)
    assertThat(AcsMeetingSession.sampleRateHz(AudioStreamSampleRate.HZ_24000)).isEqualTo(24000)
    assertThat(AcsMeetingSession.sampleRateHz(AudioStreamSampleRate.HZ_32000)).isEqualTo(32000)
    assertThat(AcsMeetingSession.sampleRateHz(AudioStreamSampleRate.HZ_44100)).isEqualTo(44100)
    assertThat(AcsMeetingSession.sampleRateHz(AudioStreamSampleRate.HZ_48000)).isEqualTo(48000)
    assertThat(AcsMeetingSession.sampleRateHz(null)).isNull()
  }
}
