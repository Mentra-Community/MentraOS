# E2E Transcription Metrics

This folder contains the live transcription delay monitor used on a real Android phone, with local audio playback and a browser dashboard.

The current production path for this harness is:

- word-level ground truth from Hugging Face word-timestamp data
- visible transcription timing from `E2E_METRIC` app logs in `adb logcat`
- live dashboard served locally by `scripts/live_word_monitor.py`
- optional public sharing via Cloudflare Tunnel

## Layout

- `scripts/live_word_monitor.py`: current live dashboard and monitor
- `scripts/serve_monitor_history.py`: serves previously captured monitor history
- `results/`: NDJSON, cache, and monitor outputs

## Current Signal Source

The current live monitor primarily uses machine-readable `E2E_METRIC` log lines from the app:

- `local_transcription_received`
- `local_transcription_processed`
- `display_text_main`
- `display_store_update`
- `display_view_changed`

For the current dashboard, delay is computed from:

- observed timestamp: first accepted visible word match from `display_store_update`
- expected timestamp: word **end** time from the reference data

This means a "perfect" transcription model would trend near `0 ms` by this metric.

## MacOS Setup

### 1. Install prerequisites

- Bun
- Python 3
- Android platform tools / `adb`
- `cloudflared`
- Java 17 or Android Studio JBR if you also build the app locally

Recommended installs on macOS:

```bash
brew install bun
brew install android-platform-tools
brew install cloudflared
```

### 2. Clone the repos

```bash
git clone <MentraOS repo>
git clone <LiveCaptionsOnSmartGlasses repo>
```

### 3. Install repo dependencies

For the mobile repo:

```bash
cd /path/to/MentraOS/mobile
bun install
```

For the mini app repo:

```bash
cd /path/to/LiveCaptionsOnSmartGlasses
bun install
```

### 4. Run the mini app backend

```bash
cd /path/to/LiveCaptionsOnSmartGlasses
MENTRA_LOG_LEVEL=debug bun run dev
```

### 5. Make sure the phone can use the app

You need a working MentraOS app on the phone and a path for the phone to reach the captions mini app.

Choose one:

- your hosted Mentra cloud / marketplace path
- a local development routing path you control

The phone must be able to open the captions mini app and render the `Simulated glasses` mirror view.

### 6. Run the monitor

```bash
cd /path/to/MentraOS/mobile/e2e-test
python3 scripts/live_word_monitor.py \
  --output-dir results \
  --port 8765
```

Then open:

- [http://127.0.0.1:8765](http://127.0.0.1:8765)

### 7. Set up Cloudflare Tunnel on the new machine

Login to the correct zone:

```bash
cloudflared tunnel login
```

Create a tunnel if needed:

```bash
cloudflared tunnel create captions
```

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /Users/<you>/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: captions.smartglasses.art
    service: http://127.0.0.1:8765
  - service: http_status:404
```

Attach DNS:

```bash
cloudflared tunnel route dns captions captions.smartglasses.art
```

Run the tunnel:

```bash
cloudflared --config /Users/<you>/.cloudflared/config.yml tunnel run captions
```

### 8. Verify the new machine

Local checks:

```bash
curl http://127.0.0.1:8765
lsof -nP -iTCP:8765 -sTCP:LISTEN
```

Tunnel checks:

```bash
cloudflared tunnel info captions
```

Public check:

```bash
curl -A 'Mozilla/5.0' https://captions.smartglasses.art
```

## Notes

- The monitor server is Python, not Expo; restart it after code changes.
- The dashboard now uses Plotly for chart interaction.
- The chart is intended for incident review as well as live monitoring, so older windows can be inspected from the UI.

## Running it

### 1. Start the local captions mini app backend (optional, can instead use the deployed com.mentra.captions)

From the mini app repo:

```bash
gh repo clone Mentra-Community/LiveCaptionsOnSmartGlasses
MENTRA_LOG_LEVEL=debug bun run dev
```

Expected:

- the app server listens on `:3333`

### 2. Keep the phone and app in the right state

- Connect the Android phone over USB.
- Open MentraOS on the phone.
- Start the captions mini app.
- GO back to the home using `Simulated glasses`. The mirror view should stay visible.
- Keep the phone awake.

### 3. Start the live dashboard monitor

From the MentraOS repo:

```bash
cd mobile/e2e-tests
python3 scripts/live_word_monitor.py \
  --output-dir results \
  --port 8765
```

Open:

- local: [http://127.0.0.1:8765](http://127.0.0.1:8765)

Notes:

- this script does **not** hot reload; restart it after code changes
- it writes cache and monitor output under `results`
- if startup fails because cached utterance history is on an old schema, remove or migrate `results/utterance_reports.ndjson`

### 4. Optional: expose the dashboard publicly

Only if needed:

```bash
cloudflared --config ~/.cloudflared/config.yml tunnel run captions
```

Expected public URL:

- [https://captions.smartglasses.art](https://captions.smartglasses.art)

If that hostname shows `1033`, the tunnel runner is not alive.

Quick check:

```bash
cloudflared tunnel info captions
```

### 5. Recovery commands

If the monitor looks stale:

```bash
pkill -f 'mobile/e2e-test/scripts/live_word_monitor.py'
cd mobile/e2e-test
python3 scripts/live_word_monitor.py \
  --output-dir results \
  --port 8765
```

If the public URL is down:

```bash
cloudflared --config ~/.cloudflared/config.yml tunnel run captions
```
