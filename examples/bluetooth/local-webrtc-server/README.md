# Local MediaMTX Server

This helper runs a local [MediaMTX](https://mediamtx.org/) server for testing Mentra Live streaming from the example apps.

MediaMTX provides the local ingest and playback endpoints needed for a demo:

- **RTMP ingest**: a local RTMP URL that the example app sends to the glasses.
- **SRT ingest**: a local SRT URL that the example app sends to the glasses.
- **HLS playback**: a browser URL for previewing an RTMP or SRT stream on your computer.
- **WHIP ingest**: the URL that the example app sends to the glasses.
- **WHEP/WebRTC playback**: the URL you open locally to preview the live stream.

## Requirements

- Docker Desktop or Docker Engine
- A phone, glasses, and computer on the same reachable network
- Mentra Live connected to Wi-Fi

## Run

From this repository:

```bash
examples/local-webrtc-server/run-mediamtx.sh
```

The script prints URLs like:

```text
RTMP publish URL:
  rtmp://192.168.1.42:1935/live/mentra-live

RTMP browser preview (HLS):
  http://192.168.1.42:8888/live/mentra-live

Optional RTMP ffplay preview:
  ffplay -fflags nobuffer -flags low_delay -framedrop rtmp://192.168.1.42:1935/live/mentra-live

SRT publish URL:
  srt://192.168.1.42:8890?streamid=publish:mentra-live&pkt_size=1316

SRT browser preview (HLS):
  http://192.168.1.42:8888/mentra-live

Optional SRT ffplay preview:
  ffplay -fflags nobuffer -flags low_delay -framedrop "srt://192.168.1.42:8890?streamid=read:mentra-live"

WHIP publish URL:
  http://192.168.1.42:8889/mentra-live/whip

WebRTC browser preview:
  http://192.168.1.42:8889/mentra-live

WHEP playback URL:
  http://192.168.1.42:8889/mentra-live/whep
```

Paste the printed **RTMP publish URL** into the Stream tab's RTMP field, paste the printed **SRT publish URL** into the SRT field, or paste the printed **WHIP publish URL** into the WebRTC field, then tap **Start stream**.

For RTMP and SRT, the native iOS example derives the HLS preview URL from the publish URL and embeds it in the preview card after the stream starts. You can also open the printed browser preview URL on your computer, or use the printed `ffplay` command when debugging locally. For WebRTC, open the printed **WebRTC browser preview** URL or use the printed **WHEP playback URL** if you are building your own player.

RTMP URLs need both an application segment and a stream key segment. The default `/live/mentra-live` path is intentional; a one-segment RTMP path such as `/mentra-live` is rejected by the Mentra Live RTMP client.

The helper starts MediaMTX with MPEG-TS HLS segments for broad iOS player compatibility. If an older `mentra-webrtc` container is already running, stop it with `docker stop mentra-webrtc` and rerun the helper before testing the iOS RTMP preview.

## Network Notes

Use the LAN URL printed by the script, not `localhost`, from the example app. The stream is produced by the glasses and controlled by the phone, so both the phone and glasses must be able to reach the computer's LAN IP.

If the script picks the wrong interface, set the IP explicitly:

```bash
MENTRA_STREAM_HOST_IP=192.168.1.42 examples/local-webrtc-server/run-mediamtx.sh
```

You can also change the stream paths:

```bash
MENTRA_RTMP_STREAM_PATH=live/my-stream MENTRA_SRT_STREAM_PATH=my-stream MENTRA_WEBRTC_STREAM_PATH=my-stream examples/local-webrtc-server/run-mediamtx.sh
```

That changes the URLs to:

```text
rtmp://<computer-ip>:1935/live/my-stream
http://<computer-ip>:8888/live/my-stream
srt://<computer-ip>:8890?streamid=publish:my-stream&pkt_size=1316
http://<computer-ip>:8888/my-stream
http://<computer-ip>:8889/my-stream/whip
http://<computer-ip>:8889/my-stream
http://<computer-ip>:8889/my-stream/whep
```

For backwards compatibility, `MENTRA_STREAM_PATH=my-stream` still sets RTMP, SRT, and WebRTC to the same path.

## Troubleshooting

- If the example app reports that the stream started but the preview page never shows video, confirm the glasses are connected to Wi-Fi and can reach the computer's LAN IP.
- HLS preview is only available after the RTMP or SRT publisher starts. Refresh the HLS URL after tapping **Start stream**.
- If WebRTC connects locally on the computer but not from another device, confirm Docker is publishing UDP ports `8890` and `8189`.
- If the phone and glasses are on guest Wi-Fi, client isolation may block access to your computer. Use a normal LAN or hotspot where local device-to-device traffic is allowed.
- If Docker says the container name is already in use, stop the previous server with `docker stop mentra-webrtc`.
