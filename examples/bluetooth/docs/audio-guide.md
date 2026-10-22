# Audio Guide

The SDK can emit microphone events and local transcription results on supported devices. Mentra Live and G2 both have microphones. Mentra Live has a speaker; G2 does not. Treat audio as an advanced feature: request permission only when the user enables it, and provide clear privacy copy.

## Playback Route

The BLE connection is used for SDK commands and microphone data. Phone-originated playback uses the platform Bluetooth audio route instead.

On Android, Mentra Live starts Bluetooth Classic bonding after the BLE connection is established. The user must accept the Android pairing dialog. Once the glasses are bonded and connected as a media audio device, normal Android media playback routes to the glasses.

On iOS, apps cannot trigger Bluetooth Classic audio pairing. Ask the user to open iOS Settings > Bluetooth, pair/connect the glasses, and select them as the audio output before playing audio. If the glasses are not the active system audio route, playback can come from the phone speaker.

For production apps, fail closed for audible playback when you can verify that the glasses are not the active audio route. The native example apps demonstrate this by refusing to play the recorded microphone sample unless the platform reports an active Bluetooth audio route.

## Glasses Media Volume

On Mentra Live, the SDK can read and set the glasses media step volume over BLE. This is separate from the phone OS audio route. If Android shows a music-note volume icon instead of a Bluetooth icon, the phone is probably controlling local media output even if the BLE glasses volume command succeeds. Phone hardware volume buttons change the active Android media stream; they do not automatically change this BLE-reported glasses volume.

Android:

```kotlin
val result = sdk.getGlassesMediaVolume()
println("Glasses media volume: ${result.level ?: "unknown"} / 15")

sdk.setGlassesMediaVolume(8)
```

React Native:

```ts
const result = await BluetoothSdk.getGlassesMediaVolume();
console.log(`Glasses media volume: ${result.level} / 15`);

await BluetoothSdk.setGlassesMediaVolume(8);
```

`getGlassesMediaVolume()` returns `level`, plus a `statusCode` when the glasses provide one. Native platforms may return `level = null` if the glasses respond without a readable volume. Unsupported devices throw an SDK error. `setGlassesMediaVolume(level)` requires `0..15`; unsupported devices or disconnected glasses throw an SDK error.

## Enable Microphone Events

Android:

```kotlin
sdk.setPreferredMic(MicPreference.AUTO)
sdk.setMicState(enabled = true)
```

iOS:

```swift
sdk.setPreferredMic(.auto)
sdk.setMicState(enabled: true)
```

React Native:

```ts
await BluetoothSdk.setOwnAppAudioPlaying(false);
await BluetoothSdk.setMicState(true);
```

`setMicState(enabled)` defaults to glasses microphone audio, transcript events off, and LC3 events off. Microphone audio events are continuous while capture is enabled; glasses-side Voice Activity Detection status is reported separately through `voice_activity_detection_status` and `speaking_status` events when supported.

## Voice Activity Detection

Voice Activity Detection is a glasses-side setting on Mentra Live. When enabled, the glasses report whether speech is currently active; when disabled, PCM capture still works continuously.

```ts
await BluetoothSdk.setVoiceActivityDetectionEnabled(true);

BluetoothSdk.addListener('speaking_status', (event) => {
  console.log(event.speaking ? 'speaking' : 'not speaking');
});
```

## PCM Audio

Android:

```kotlin
override fun onMicPcm(event: MicPcmEvent) {
    // Forward event.pcm to your audio pipeline.
    // event.sampleRate == 16000, event.bitsPerSample == 16, event.channels == 1.
}
```

iOS:

```swift
func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceiveMicPcm event: MicPcmEvent) {
    // Forward event.pcm to your audio pipeline.
    // event.sampleRate == 16000, event.bitsPerSample == 16, event.channels == 1.
}
```

React Native:

```tsx
import {useBluetoothEvent} from '@mentra/bluetooth-sdk/react';

export function MicPcmLogger() {
  useBluetoothEvent('mic_pcm', (event) => {
    // Forward event.pcm to your audio pipeline.
    console.log(event.sampleRate, event.bitsPerSample, event.channels, event.encoding);
  });

  return null;
}
```

## LC3 Audio

Android:

```kotlin
override fun onMicLc3(event: MicLc3Event) {
    // Decode or forward event.lc3 depending on your pipeline.
    // event.frameDurationMs, event.frameSizeBytes, and event.bitrate describe the frame.
}
```

iOS:

```swift
func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceiveMicLc3 event: MicLc3Event) {
    // Decode or forward event.lc3 depending on your pipeline.
    // event.frameDurationMs, event.frameSizeBytes, and event.bitrate describe the frame.
}
```

React Native:

```tsx
import {useBluetoothEvent} from '@mentra/bluetooth-sdk/react';

export function MicLc3Logger() {
  useBluetoothEvent('mic_lc3', (event) => {
    // Decode or forward event.lc3 depending on your pipeline.
    console.log(event.frameDurationMs, event.frameSizeBytes, event.bitrate);
  });

  return null;
}
```

## Local Transcription

Android:

```kotlin
override fun onLocalTranscription(event: LocalTranscriptionEvent) {
    Log.d("Mentra", "${event.text} final=${event.isFinal}")
}
```

iOS:

```swift
func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceive event: BluetoothEvent) {
    if case let .localTranscription(transcription) = event {
        print("\(transcription.text) final=\(transcription.isFinal)")
    }
}
```

React Native:

```tsx
import {useBluetoothEvent} from '@mentra/bluetooth-sdk/react';

export function TranscriptLogger() {
  useBluetoothEvent('local_transcription', (event) => {
    console.log(`${event.text} final=${event.isFinal}`);
  });

  return null;
}
```

## Production Notes

- Always provide a user-visible microphone permission explanation.
- Let users disable microphone streaming.
- Expect model availability to differ by platform, locale, and app configuration.
- Keep cloud upload and retention policies explicit in your privacy disclosures.
- Disable raw audio callbacks when the app no longer needs them.
