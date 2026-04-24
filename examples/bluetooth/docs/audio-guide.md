# Audio Guide

The SDK can emit microphone events and local transcription results on supported devices.

## Enable Microphone Events

```ts
await BluetoothSdk.setMicState(
  true, // sendPcmData
  true, // sendTranscript
  false, // bypassVad
);
```

## PCM Audio

```ts
const sub = BluetoothSdk.addListener("mic_pcm", (event) => {
  const pcm = event.pcm;
  // Forward to your audio pipeline.
});

sub.remove();
```

## LC3 Audio

```ts
const sub = BluetoothSdk.addListener("mic_lc3", (event) => {
  const lc3 = event.lc3;
  // Decode or forward depending on your pipeline.
});
```

## Local Transcription

```ts
const sub = BluetoothSdk.addListener("local_transcription", (event) => {
  console.log(event.text, event.isFinal);
});
```

## Local STT Models

```ts
const available = await BluetoothSdk.checkSttModelAvailable();

if (available) {
  await BluetoothSdk.restartTranscriber();
}
```

For custom model deployments:

```ts
const valid = await BluetoothSdk.validateSttModel(modelPath);

if (valid) {
  await BluetoothSdk.setSttModelDetails(modelPath, "en");
  await BluetoothSdk.restartTranscriber();
}
```

## Production Notes

- Always provide a user-visible microphone permission explanation.
- Let users disable microphone streaming.
- Expect model availability to differ by platform, locale, and partner app configuration.
- Keep cloud upload and retention policies explicit in your privacy disclosures.
