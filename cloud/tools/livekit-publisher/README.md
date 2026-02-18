# livekit-publisher

Loop a local 16‑bit PCM WAV file into a LiveKit room as a raw PCM audio track. Designed to be very small & readable if you normally write TypeScript.

## Features

- Publishes a single raw PCM track (`--track-name`, default `loop`).
- Reads the entire WAV into memory (mono or stereo, any sample rate; must be 16‑bit PCM).
- Splits audio into fixed frames (default 10ms) and writes them at wall‑clock rate.
- Optional gain adjustment with clipping protection.
- Loop forever (default) or `--once` to play a single pass.
- Minimal logging with periodic progress.

## Build / Run

From repo root:

```bash
cd cloud/tools/livekit-publisher
go run . \
	--url "$LIVEKIT_URL" \
	--room "$LIVEKIT_ROOM_NAME" \
	--wav ./assets/sample.wav \
	--api-key "$LIVEKIT_API_KEY" \
	--api-secret "$LIVEKIT_API_SECRET"
```

If you already have a pre‑minted token (`LIVEKIT_TOKEN`) that grants `room_join` for the room, you can skip api key/secret:

```bash
go run . --url "$LIVEKIT_URL" --room "$LIVEKIT_ROOM_NAME" --token "$LIVEKIT_TOKEN" --wav ./assets/sample.wav
```

### Using a .env file (simplest)

Create `.env` in this folder (already present in repo example):

```
LIVEKIT_URL=wss://your-host.livekit.cloud
LIVEKIT_API_KEY=YOUR_KEY
LIVEKIT_API_SECRET=YOUR_SECRET
LIVEKIT_ROOM_NAME=your-room
LIVEKIT_IDENTITY=publisher-1
```

Then you can run with only the WAV flag:

```bash
go run . --wav ./assets/good-morning-2033-16k.wav
```

Order of precedence for connection parameters:

1. Explicit CLI flag
2. Environment variable (including values loaded from .env)

If `--token` is absent but `LIVEKIT_API_KEY` + `LIVEKIT_API_SECRET` are present, a token is minted automatically.

```bash
go run . --wav ./assets/good-morning-2033-16k.wav
```

To publish only once:

```bash
go run . --url "$LIVEKIT_URL" --room "$LIVEKIT_ROOM_NAME" --wav ./assets/sample.wav --token "$LIVEKIT_TOKEN" --once
```

## Flags

| Flag           | Env                  | Description                                              |
| -------------- | -------------------- | -------------------------------------------------------- |
| `--url`        | `LIVEKIT_URL`        | LiveKit WS URL (e.g. `wss://host/livekit`).              |
| `--room`       | `LIVEKIT_ROOM_NAME`  | Room name to join.                                       |
| `--token`      | `LIVEKIT_TOKEN`      | Pre-minted access token (skip `--api-key/--api-secret`). |
| `--api-key`    | `LIVEKIT_API_KEY`    | API key (if minting a token locally).                    |
| `--api-secret` | `LIVEKIT_API_SECRET` | API secret (used with key).                              |
| `--identity`   | `LIVEKIT_IDENTITY`   | Participant identity (auto-generated if empty).          |
| `--wav`        | (none)               | Path to 16‑bit PCM WAV file (required).                  |
| `--track-name` | (none)               | Track publication name (default `loop`).                 |
| `--gain`       | (none)               | Linear gain multiplier (default 1.0).                    |
| `--once`       | (none)               | Play a single pass instead of looping.                   |
| `--frame-ms`   | (none)               | Frame size in ms (default 10).                           |
| `--log-every`  | (none)               | Log every N frames (default 100, 0 disables).            |

## Creating a Test WAV

Use `sox` or `ffmpeg` to create a short mono 16‑bit test tone:

```bash
# 2s 440Hz sine, 16kHz mono 16-bit PCM
sox -n -r 16000 -b 16 -c 1 assets/sample.wav synth 2 sine 440
```

Or with `ffmpeg`:

```bash
ffmpeg -f lavfi -i "sine=frequency=440:duration=2" -ar 16000 -ac 1 -sample_fmt s16 assets/sample.wav
```

## How It Works (Quick Tour)

1. Parse flags / env.
2. Load WAV: parse RIFF header, pull `fmt ` + `data` chunks (PCM only).
3. Optionally mint a token (API key + secret) if `--token` absent.
4. Connect to room; create `PCMLocalTrack` with WAV sample rate & channels.
5. Convert bytes -> `[]int16`; apply gain (with clipping guard).
6. Every `frame-ms` push a slice into `WriteSample`. Wrap when end reached.

Because we use the WAV's native sample rate, the server / subscribers handle any resampling as needed.

## Typical Issues

| Symptom                           | Cause                                         | Fix                                                                      |
| --------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------ |
| Immediate exit: `need 16-bit pcm` | WAV not s16le                                 | Re-export as 16‑bit signed little endian.                                |
| Silence on remote                 | Token missing `room_join` / wrong room        | Re‑mint token with correct grant & room.                                 |
| Fast or slow playback             | Corrupt `frame-ms` or mutated sample rate     | Use integer `--frame-ms` (5–60 typical).                                 |
| Distortion/clipping               | Gain too high                                 | Lower `--gain` (1.0 = unity).                                            |
| `pkg-config` / opus errors        | Native opus libs required by full media stack | Install: `brew install pkg-config opus` (or keep current minimal usage). |

## Minimal Docker-ish Runtime (Optional)

If you vendor modules, you can build a static binary:

```bash
go build -o livekit-publisher .
./livekit-publisher --url "$LIVEKIT_URL" --room "$LIVEKIT_ROOM_NAME" --wav assets/sample.wav --token "$LIVEKIT_TOKEN"
```

## Exit Behavior

The current version runs until the process is interrupted (Ctrl+C) or (if `--once`) until a single pass finishes.

## Roadmap / Possible Enhancements

- Optional graceful SIGINT trap with final stats.
- Real-time bitrate / frames-per-second counters.
- Support Opus encoding instead of raw PCM (bandwidth saving).
- Optional fade-in/out between loops.

PRs welcome.
