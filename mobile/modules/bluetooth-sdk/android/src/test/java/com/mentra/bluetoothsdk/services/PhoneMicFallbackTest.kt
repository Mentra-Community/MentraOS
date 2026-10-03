package com.mentra.bluetoothsdk.services

import android.Manifest
import android.content.Context
import android.media.AudioManager
import com.mentra.bluetoothsdk.Bridge
import com.mentra.bluetoothsdk.utils.MicTypes
import org.assertj.core.api.Assertions.assertThat
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import org.robolectric.shadows.ShadowAudioRecord

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
@LooperMode(LooperMode.Mode.PAUSED)
class PhoneMicFallbackTest {
  private lateinit var mic: PhoneMic

  @Before
  fun setUp() {
    val context = RuntimeEnvironment.getApplication()
    shadowOf(context).grantPermissions(Manifest.permission.RECORD_AUDIO)
    Bridge.initialize(context)
    val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    shadowOf(audioManager).setIsBluetoothScoAvailableOffCall(true)
    // Keep the test recorder alive without forwarding synthetic audio to DeviceManager.
    ShadowAudioRecord.setSource(object : ShadowAudioRecord.AudioRecordSource {
      override fun readInShortArray(buffer: ShortArray, offset: Int, size: Int, blocking: Boolean): Int {
        try { Thread.sleep(1) } catch (_: InterruptedException) {}
        return 0
      }
    })
    val constructor = PhoneMic::class.java.getDeclaredConstructor(Context::class.java)
    constructor.isAccessible = true
    mic = constructor.newInstance(context)
  }

  @After
  fun tearDown() {
    mic.cleanup()
    ShadowAudioRecord.clearSource()
  }

  @Test
  fun unavailableHighQualityProfileDoesNotBlockImmediateHfpFallback() {
    assertThat(mic.startMode(MicTypes.BLUETOOTH)).isFalse()
    assertThat(mic.startMode(MicTypes.BLUETOOTH_CLASSIC)).isTrue()
    assertThat(mic.isRecordingWithMode(MicTypes.BLUETOOTH_CLASSIC)).isTrue()
  }

  @Test
  fun reevaluatingUnavailableProfileDoesNotStopActiveHfpRecorder() {
    assertThat(mic.startMode(MicTypes.BLUETOOTH_CLASSIC)).isTrue()
    assertThat(mic.startMode(MicTypes.BLUETOOTH)).isFalse()
    assertThat(mic.isRecordingWithMode(MicTypes.BLUETOOTH_CLASSIC)).isTrue()
  }

  @Test
  fun switchingFromPhoneToHfpDoesNotRequireWaitingForDebounce() {
    assertThat(mic.startMode(MicTypes.PHONE_INTERNAL)).isTrue()
    assertThat(mic.startMode(MicTypes.BLUETOOTH)).isFalse()
    assertThat(mic.isRecordingWithMode(MicTypes.PHONE_INTERNAL)).isTrue()
    assertThat(mic.startMode(MicTypes.BLUETOOTH_CLASSIC)).isTrue()
    assertThat(mic.isRecordingWithMode(MicTypes.BLUETOOTH_CLASSIC)).isTrue()
  }
}
