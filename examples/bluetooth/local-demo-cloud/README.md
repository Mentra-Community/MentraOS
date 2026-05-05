# Local Demo Cloud

This is the recommended local companion service for running the SDK example apps.
It starts the photo upload webhook and a local MediaMTX streaming server from
one command, then prints the URLs to paste into the Android, iOS, or React
Native examples.

The Python process owns the simple HTTP photo webhook. RTMP, HLS, and WebRTC
media are delegated to MediaMTX because live media ingest and playback require a
real media server, not just extra HTTP routes.

## Requirements

- Python 3
- Docker Desktop or Docker Engine for RTMP/WebRTC streaming only
- Optional: FFmpeg if you want to use the printed `ffplay` debug command
- A phone, glasses, and computer on the same reachable network
- Mentra Live connected to Wi-Fi for streaming

On macOS, install FFmpeg with:

```bash
brew install ffmpeg
```

## Run

From this repository:

```bash
python3 examples/local-demo-cloud/server.py
```

The command prints URLs like:

```text
Photo upload URL:
  http://192.168.1.42:8787/upload

RTMP publish URL:
  rtmp://192.168.1.42:1935/live/mentra-live

RTMP browser preview (HLS):
  http://192.168.1.42:8888/live/mentra-live

Optional RTMP ffplay preview:
  ffplay -fflags nobuffer -flags low_delay -framedrop rtmp://192.168.1.42:1935/live/mentra-live

WHIP publish URL:
  http://192.168.1.42:8889/mentra-live/whip

WebRTC browser preview:
  http://192.168.1.42:8889/mentra-live

WHEP playback URL:
  http://192.168.1.42:8889/mentra-live/whep
```

Paste the photo URL into the Camera screen. For RTMP, paste the RTMP publish URL
into the Stream screen's RTMP field. The native iOS example derives the HLS
preview URL and shows it in the preview card after the stream starts; you can
also open the HLS preview URL on your computer. For WebRTC, paste the WHIP URL
into the Stream screen's WebRTC field and open the WebRTC preview URL on your
computer.

RTMP URLs need both an application segment and a stream key segment. The default
`/live/mentra-live` path is intentional; a one-segment RTMP path such as
`/mentra-live` is rejected by the Mentra Live RTMP client.

The helper starts MediaMTX with MPEG-TS HLS segments for broad iOS player
compatibility. If an older `mentra-webrtc` container is already running, stop it
with `docker stop mentra-webrtc` and rerun the helper before testing the iOS
RTMP preview.

The HLS preview URL becomes useful after the RTMP stream starts. If you open it
before tapping **Start stream**, refresh the page after the glasses begin
publishing.

Use the LAN URL printed by the script, not `localhost`, from the example app.
The phone and glasses must be able to reach your computer's LAN IP.

If Docker is not installed or not running, the command still starts the photo
webhook and prints a streaming warning. This lets you test photo upload without
installing streaming dependencies.

## Options

If the script picks the wrong network interface, pass the host IP explicitly:

```bash
python3 examples/local-demo-cloud/server.py --host-ip 192.168.1.42
```

You can also change ports or the stream path:

```bash
python3 examples/local-demo-cloud/server.py --photo-port 8788 --rtmp-port 1936 --hls-port 8887 --rtmp-path live/my-stream --webrtc-path my-stream
```

Run only the photo webhook:

```bash
python3 examples/local-demo-cloud/server.py --photo-only
```

Run only the streaming helper:

```bash
python3 examples/local-demo-cloud/server.py --streaming-only
```

CI or streaming-specific demos can fail hard when MediaMTX is unavailable:

```bash
python3 examples/local-demo-cloud/server.py --require-streaming
```

## Lower-Level Helpers

The underlying helpers are still available if you want to run only one side:

- `examples/photo-webhook-server/server.py`
- `examples/local-webrtc-server/run-mediamtx.sh`
