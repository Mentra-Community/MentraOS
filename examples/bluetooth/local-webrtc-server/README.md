# Local MediaMTX Server

This helper runs a local [MediaMTX](https://mediamtx.org/) server for testing Mentra Live streaming from the example apps.

MediaMTX provides the local ingest and playback endpoints needed for a demo:

- **RTMP ingest**: a local RTMP URL that the example app sends to the glasses.
- **HLS playback**: a browser URL for previewing an RTMP stream on your computer.
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
  rtmp://192.168.1.42:1935/mentra-live

RTMP browser preview (HLS):
  http://192.168.1.42:8888/mentra-live

WHIP publish URL:
  http://192.168.1.42:8889/mentra-live/whip

WebRTC browser preview:
  http://192.168.1.42:8889/mentra-live

WHEP playback URL:
  http://192.168.1.42:8889/mentra-live/whep
```

Paste the printed **RTMP publish URL** into the Stream tab's RTMP field, or paste the printed **WHIP publish URL** into the WebRTC field, then tap **Start stream**.

For RTMP, open the printed **RTMP browser preview (HLS)** URL on your computer. You can also use the printed `ffplay` command when debugging locally. For WebRTC, open the printed **WebRTC browser preview** URL or use the printed **WHEP playback URL** if you are building your own player.

## Network Notes

Use the LAN URL printed by the script, not `localhost`, from the example app. The stream is produced by the glasses and controlled by the phone, so both the phone and glasses must be able to reach the computer's LAN IP.

If the script picks the wrong interface, set the IP explicitly:

```bash
MENTRA_WEBRTC_HOST_IP=192.168.1.42 examples/local-webrtc-server/run-mediamtx.sh
```

You can also change the stream path:

```bash
MENTRA_STREAM_PATH=my-stream examples/local-webrtc-server/run-mediamtx.sh
```

That changes the URLs to:

```text
rtmp://<computer-ip>:1935/my-stream
http://<computer-ip>:8888/my-stream
http://<computer-ip>:8889/my-stream/whip
http://<computer-ip>:8889/my-stream
http://<computer-ip>:8889/my-stream/whep
```

## Troubleshooting

- If the example app reports that the stream started but the preview page never shows video, confirm the glasses are connected to Wi-Fi and can reach the computer's LAN IP.
- HLS preview is only available after the RTMP publisher starts. Refresh the HLS URL after tapping **Start stream**.
- If WebRTC connects locally on the computer but not from another device, confirm Docker is publishing UDP ports `8890` and `8189`.
- If the phone and glasses are on guest Wi-Fi, client isolation may block access to your computer. Use a normal LAN or hotspot where local device-to-device traffic is allowed.
- If Docker says the container name is already in use, stop the previous server with `docker stop mentra-webrtc`.
