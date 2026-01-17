# Test Audio Files for E2E Testing

This directory contains audio files used for automated E2E testing of transcription features.

## Requirements

Audio files must be:
- **Format**: WAV (RIFF/WAVE)
- **Sample Rate**: 16000 Hz (16kHz)
- **Channels**: Mono (1 channel) preferred, stereo will use left channel only
- **Bit Depth**: 16-bit signed PCM

## Converting Audio Files

Use ffmpeg to convert audio to the correct format:

```bash
# Convert any audio file to 16kHz mono 16-bit WAV
ffmpeg -i input.mp3 -ar 16000 -ac 1 -sample_fmt s16 output.wav

# Convert with specific duration (e.g., first 10 seconds)
ffmpeg -i input.mp3 -ar 16000 -ac 1 -sample_fmt s16 -t 10 output.wav
```

## Generating Test Audio with Text-to-Speech

### macOS (using say command)
```bash
# Generate speech and convert to correct format
say -o temp.aiff "Hello world. Testing one two three. The quick brown fox jumps over the lazy dog."
ffmpeg -i temp.aiff -ar 16000 -ac 1 -sample_fmt s16 hello-world.wav
rm temp.aiff
```

### Using Google Cloud TTS or other services
```bash
# After downloading MP3 from TTS service
ffmpeg -i tts-output.mp3 -ar 16000 -ac 1 -sample_fmt s16 hello-world.wav
```

## File Naming Convention

- `hello-world.wav` - Basic test phrase for quick validation
- `numbers-count.wav` - Counting numbers for numeric transcription
- `conversation-short.wav` - Short conversation snippet
- `conversation-long.wav` - Longer conversation for stress testing

## Usage in Tests

Files are pushed to device via ADB before tests:
```bash
adb push .maestro/test-audio/hello-world.wav /sdcard/Download/mentra-test/
```

Then injected via CoreModule:
```typescript
await CoreModule.injectTestAudioFromFile('/sdcard/Download/mentra-test/hello-world.wav')
```
