# Local WHIP / WHEP for Mentra Live → laptop WebRTC

Stream the Mentra Live glasses camera over the same Wi‑Fi to a MediaMTX
instance on this laptop via **WHIP** (WebRTC publish), and watch it via
**WHEP** in a browser.

```
Phone (Mentra App / Livestreamer)  --BLE start_stream-->  Mentra Live glasses
                                                              |
                                                              | WHIP (Wi‑Fi)
                                                              v
                                                    Laptop MediaMTX :8889
                                                              |
                                                              | WHEP
                                                              v
                                                       Browser viewer
```

Glasses treat any `http://` / `https://` ingest URL as WHIP
(`StreamCommandHandler`). Livestreamer Custom + **Local network** sends that
URL as an unmanaged / direct stream.

## Quick start

1. Put glasses, phone, and this laptop on the **same Wi‑Fi**.
2. From the MentraOS repo root:

   ```bash
   ./scripts/local-whip/start-local-whip.sh
   ```

   The script detects the laptop LAN IP every run (DHCP-safe), starts
   MediaMTX, and prints:

   - **Publish:** `http://<LAN_IP>:8889/live/whip`
   - **Watch:** `http://<LAN_IP>:8889/live`

3. **Firewall / ICE (most likely failure mode)**

   Docker Desktop + macOS firewall on **TCP 8889** / **UDP 8189** is the
   usual landmine.

   - Allow Docker/MediaMTX inbound on those ports.
   - If the WHIP POST returns **201** but no video ever arrives, that is an
     **ICE/UDP** failure, not a WHIP signaling failure. Check the firewall
     first, then widen the UDP mapping in `docker-compose.yml` if needed.
   - `network_mode: host` can rule out Docker NAT on Linux only — it is
     **not** available on Docker Desktop for macOS.

4. Confirm the glasses path **without** Livestreamer (recommended first):

   ```bash
   ./asg_client/scripts/test-webrtc-streaming.sh start http://<LAN_IP>:8889/live/whip
   ./asg_client/scripts/test-webrtc-streaming.sh logs
   ./asg_client/scripts/test-webrtc-streaming.sh stop
   ```

5. In Livestreamer:

   - Platform: **Custom**
   - Stream Server URL: the publish URL from step 2
   - Stream key: leave blank
   - Enable **Local network**
   - Connect → Go Live (unmanaged / direct)

6. Open the watch URL in a laptop browser.

7. Stop the server:

   ```bash
   docker compose -f scripts/local-whip/docker-compose.yml down
   ```

## Files

| File | Role |
|------|------|
| `mediamtx.yml` | MediaMTX config (`live` path, WebRTC on `:8889`) |
| `docker-compose.yml` | Publishes `8889/tcp`, `8189/udp`; requires `MTX_WEBRTCADDITIONALHOSTS` |
| `start-local-whip.sh` | Detects LAN IP → exports ICE host → `docker compose up` |

`webrtcAdditionalHosts` is **not** hardcoded in `mediamtx.yml`. The start
script sets `MTX_WEBRTCADDITIONALHOSTS=<LAN_IP>` so ICE candidates stay
correct after DHCP changes.

## Troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| Stream won't start / `no_wifi_connection` | Glasses not on Wi‑Fi |
| WHIP POST fails / connection refused | MediaMTX not running, wrong LAN IP, or TCP 8889 blocked |
| WHIP 201, no video | ICE/UDP 8189 blocked (firewall / Docker Desktop) |
| Browser page loads, black frame | Publisher never connected — check glasses logcat / ADB smoke test |
| Wrong IP in printed URLs | Disconnect VPN; re-run start script so `en0` is the Wi‑Fi interface |

Useful glasses log filter:

```bash
adb logcat | grep -E "StreamCommandHandler|WhipStreamingService"
```
