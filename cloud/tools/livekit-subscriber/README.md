# livekit-speaker

A tiny debug CLI that joins a LiveKit room and plays subscribed audio to your Mac speakers.

Usage:

- Set env LIVEKIT_URL and LIVEKIT_TOKEN (or pass --url/--token)
- Optionally set TARGET_IDENTITY to only play one participant’s audio

Run:

```
# inside repo root
cd cloud/tools/livekit-speaker
go run . --url "$LIVEKIT_URL" --token "$LIVEKIT_TOKEN" --target "$TARGET_IDENTITY"
```

Notes:

- Outputs audio at 48kHz mono via Oto. The LiveKit SDK resamples/jitter-buffers.
- Prints simple level meters to confirm cadence.
- No publishing—subscriber only.
