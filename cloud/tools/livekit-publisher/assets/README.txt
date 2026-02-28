Place .wav files here for the livekit-publisher tool.
Requirements for initial version:
- PCM 16-bit little-endian
- Mono (1 channel)
- 16000 Hz sample rate

Example: convert with sox
  sox input.wav -r 16000 -c 1 -b 16 output_mono16k.wav

These files will be referenced via --wav path.