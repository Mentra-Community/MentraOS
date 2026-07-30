# Local RTMP / SRT / WHIP for Mentra Live → laptop

Stream the Mentra Live glasses camera over the same Wi‑Fi to a MediaMTX
instance on this laptop. **RTMP is the primary path** (one TCP port, no
ICE/NAT). **SRT** and **WHIP/WHEP (WebRTC)** are also available.

```
Phone (Mentra App / Livestreamer)  --BLE start_stream-->  Mentra Live glasses
                                                              |
                                                              | RTMP / SRT / WHIP
                                                              v
                                          Laptop MediaMTX :1935 / :8890 / :8889
                                                              |
                                                              | HLS / WHEP / SRT read
                                                              v
                                                       Browser / VLC viewer
```

Glasses route by URL scheme (`StreamCommandHandler`): `rtmp://` / `rtmps://`
→ RTMP, `srt://` → SRT, `http://` / `https://` → WHIP. Livestreamer Custom +
**Local network** sends that URL as an unmanaged / direct stream.

## Quick start (RTMP — recommended)

1. Put glasses, phone, and this laptop on the **same Wi‑Fi**.
2. From the MentraOS repo root:

   ```bash
   ./scripts/local-stream/start-local-stream.sh
   ```

   The script detects the laptop LAN IP every run (DHCP-safe), starts
   MediaMTX, and prints:

   - **Publish (RTMP):** `rtmp://<LAN_IP>:1935/live/stream`
     (StreamPack requires `/app/streamKey` — a bare `/live` URL will fail)
   - **Publish (SRT):** `srt://<LAN_IP>:8890?streamid=publish:live/stream`
   - **Watch (HLS):** `http://<LAN_IP>:8888/live/stream`

3. **Firewall**

   Allow Docker/MediaMTX inbound **TCP 1935** (and **TCP 8888** if you watch
   HLS from another device). For SRT, also allow **UDP 8890**.

4. Confirm the glasses path **without** Livestreamer (recommended first):

   ```bash
   ./asg_client/scripts/test-rtmp-streaming.sh start rtmp://<LAN_IP>:1935/live/stream
   ./asg_client/scripts/test-rtmp-streaming.sh logs
   ./asg_client/scripts/test-rtmp-streaming.sh stop
   ```

5. In Livestreamer:

   - Platform: **Custom**
   - Protocol: **RTMP** (or **SRT** — see below)
   - Stream Server URL: the publish URL from step 2
   - Stream key: leave blank for the full RTMP/SRT URLs above
   - Enable **Local network**
   - Connect → Go Live (unmanaged / direct)

6. **Watch on the laptop** (the Mentra App / Livestreamer phone UI has
   **no preview** for Local-network / unmanaged streams — that card will say
   "No preview available for unmanaged streams" even when the glasses are
   publishing successfully):

   - Browser: `http://<LAN_IP>:8888/live/stream/`
   - VLC → Media → Open Network Stream:
     - `rtmp://<LAN_IP>:1935/live/stream`, or
     - `rtsp://<LAN_IP>:8554/live/stream`, or
     - `srt://<LAN_IP>:8890?streamid=read:live/stream`

7. Stop the server:

   ```bash
   docker compose -f scripts/local-stream/docker-compose.yml down
   ```

## SRT

MediaMTX expects Haivision-style `streamid` query params (not a path after the host):

- **Publish:** `srt://<LAN_IP>:8890?streamid=publish:live/stream`
- **Watch:** `srt://<LAN_IP>:8890?streamid=read:live/stream`

After an SRT publish, the same path is also available on HLS/RTSP/RTMP.

Allow inbound **UDP 8890**. Restart the start script after pulling these
config changes so Docker recreates the container with the new port mapping.

## WHIP fallback (WebRTC)

Use this only if you specifically need WebRTC publish/play. It is more
fragile on Docker Desktop + macOS because of ICE/UDP.

1. Start the same stack (`./scripts/local-stream/start-local-stream.sh`).
2. Publish: `http://<LAN_IP>:8889/live/whip`
3. Watch: `http://<LAN_IP>:8889/live`
4. Allow inbound **TCP 8889** and **UDP 8189**. If the WHIP POST returns
   **201** but no video ever arrives, that is an **ICE/UDP** failure, not a
   WHIP signaling failure.
5. Glasses-only smoke test:

   ```bash
   ./asg_client/scripts/test-webrtc-streaming.sh start http://<LAN_IP>:8889/live/whip
   ```

`webrtcAdditionalHosts` is **not** hardcoded in `mediamtx.yml`. The start
script sets `MTX_WEBRTCADDITIONALHOSTS=<LAN_IP>` so ICE candidates stay
correct after DHCP changes. RTMP/SRT do not use that env.

`network_mode: host` can rule out Docker NAT on Linux only — it is **not**
available on Docker Desktop for macOS.

## Files

| File | Role |
|------|------|
| `mediamtx.yml` | MediaMTX config (`live` + `all_others`; RTMP `:1935`, SRT `:8890`, HLS `:8888`, WebRTC `:8889`) |
| `docker-compose.yml` | Publishes `1935/tcp`, `8888/tcp`, `8889/tcp`, `8189/udp`, `8890/udp`; requires `MTX_WEBRTCADDITIONALHOSTS` |
| `start-local-stream.sh` | Detects LAN IP → exports ICE host → `docker compose up` → prints publish/watch URLs |

## Troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| Stream won't start / `no_wifi_connection` | Glasses not on Wi‑Fi |
| RTMP connection refused | MediaMTX not running, wrong LAN IP, or TCP 1935 blocked |
| SRT connection refused / timeout | MediaMTX not running, wrong LAN IP, or UDP 8890 blocked; confirm `streamid=publish:live/stream` |
| HLS page loads, black / no stream | Publisher never connected — check glasses logcat / ADB smoke test |
| WHIP POST fails / connection refused | Wrong LAN IP or TCP 8889 blocked |
| WHIP 201, no video | ICE/UDP 8189 blocked (firewall / Docker Desktop) |
| Wrong IP in printed URLs | Disconnect VPN; re-run start script so `en0` is the Wi‑Fi interface |

Useful glasses log filters:

```bash
adb logcat | grep -E "StreamCommandHandler|RtmpStreamingService|SrtStreamingService|WhipStreamingService"
```
