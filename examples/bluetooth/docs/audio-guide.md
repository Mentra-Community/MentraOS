# Audio Guide

The SDK can emit microphone events and local transcription results on supported devices. Treat audio as an advanced feature: request permission only when the user enables it, and provide clear privacy copy.

## Enable Microphone Events

Android:

```kotlin
sdk.setPreferredMic(MentraMicPreference.AUTO)
sdk.setMicState(
    MentraMicConfig(
        sendPcmData = true,
        sendTranscript = true,
        bypassVad = false,
    )
)
```

iOS:

```swift
sdk.setPreferredMic(.auto)
sdk.setMicState(
    MentraMicConfiguration(
        sendPcmData: true,
        sendTranscript: true,
        bypassVad: false
    )
)
```

## PCM Audio

Android:

```kotlin
override fun onMicPcm(frame: ByteArray) {
    // Forward to your audio pipeline.
}
```

iOS:

```swift
func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceiveMicPcm frame: Data) {
    // Forward to your audio pipeline.
}
```

## LC3 Audio

Android:

```kotlin
override fun onMicLc3(frame: ByteArray) {
    // Decode or forward depending on your pipeline.
}
```

iOS:

```swift
func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceiveMicLc3 frame: Data) {
    // Decode or forward depending on your pipeline.
}
```

## Local Transcription

Android:

```kotlin
override fun onLocalTranscription(event: MentraLocalTranscriptionEvent) {
    Log.d("Mentra", "${event.text} final=${event.isFinal}")
}
```

iOS:

```swift
func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceive event: MentraBluetoothEvent) {
    if case let .localTranscription(transcription) = event {
        print("\(transcription.text) final=\(transcription.isFinal)")
    }
}
```

## Production Notes

- Always provide a user-visible microphone permission explanation.
- Let users disable microphone streaming.
- Expect model availability to differ by platform, locale, and partner app configuration.
- Keep cloud upload and retention policies explicit in your privacy disclosures.
- Disable raw audio callbacks when the app no longer needs them.
