# Local WebRTC Server

This helper runs a local [MediaMTX](https://mediamtx.org/) server for testing Mentra Live WebRTC streaming from the example apps.

MediaMTX provides both sides needed for a local demo:

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
WHIP publish URL:
  http://192.168.1.42:8889/mentra-live/whip

Browser preview:
  http://192.168.1.42:8889/mentra-live

WHEP playback URL:
  http://192.168.1.42:8889/mentra-live/whep
```

Paste the printed **WHIP publish URL** into the Stream tab's WebRTC field in the Android, iOS, or React Native example app, then tap **Start stream**.

Open the printed **Browser preview** URL on your computer to watch the stream. If you are building your own WebRTC player, use the printed **WHEP playback URL**.

## Network Notes

Use the LAN URL printed by the script, not `localhost`, from the example app. The stream is produced by the glasses and controlled by the phone, so both the phone and glasses must be able to reach the computer's LAN IP.

If the script picks the wrong interface, set the IP explicitly:

```bash
MENTRA_WEBRTC_HOST_IP=192.168.1.42 examples/local-webrtc-server/run-mediamtx.sh
```

You can also change the stream path:

```bash
MENTRA_WEBRTC_STREAM_PATH=my-stream examples/local-webrtc-server/run-mediamtx.sh
```

That changes the URLs to:

```text
http://<computer-ip>:8889/my-stream/whip
http://<computer-ip>:8889/my-stream
http://<computer-ip>:8889/my-stream/whep
```

## Troubleshooting

- If the example app reports that the stream started but the preview page never shows video, confirm the glasses are connected to Wi-Fi and can reach the computer's LAN IP.
- If WebRTC connects locally on the computer but not from another device, confirm Docker is publishing UDP ports `8890` and `8189`.
- If the phone and glasses are on guest Wi-Fi, client isolation may block access to your computer. Use a normal LAN or hotspot where local device-to-device traffic is allowed.
- If Docker says the container name is already in use, stop the previous server with `docker stop mentra-webrtc`.
