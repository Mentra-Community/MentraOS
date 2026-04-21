# Stream Test

A minimal v3 SDK app that streams video from Mentra Live glasses to a local receiver. Useful for testing the camera streaming API and recording video locally.

## How It Works

1. You run FFmpeg on your computer, listening for an SRT connection
2. You start this app and connect your glasses
3. The glasses stream video directly to your computer via SRT
4. FFmpeg saves it as an MP4 file

This uses `session.camera.startStream({ direct: url })` which sends video straight from the glasses to your URL, bypassing the MentraOS cloud relay. No internet required — just your glasses and computer on the same WiFi network.

## Prerequisites

- [Bun](https://bun.sh/docs/installation)
- [FFmpeg](https://ffmpeg.org/download.html) (for receiving the stream)
- [ngrok](https://ngrok.com/docs/getting-started/) (for exposing your app to the cloud)
- Mentra Live glasses connected to the same WiFi as your computer
- An app registered in the [Developer Console](https://console.mentra.glass/apps) with camera permission

## Setup

### 1. Install dependencies

```bash
bun install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```
PORT=3000
PACKAGE_NAME=your.package.name
MENTRAOS_API_KEY=your_api_key
STREAM_URL=srt://YOUR_COMPUTER_IP:4201?mode=caller
```

Replace `YOUR_COMPUTER_IP` with your computer's local IP address (e.g. `192.168.1.42`). Find it with:

```bash
# macOS
ipconfig getifaddr en0

# Linux
hostname -I | awk '{print $1}'
```

### 3. Start the local receiver

Open a terminal and run FFmpeg in SRT listener mode:

```bash
mkdir -p recordings
ffmpeg -i "srt://0.0.0.0:4201?mode=listener" -c copy recordings/$(date +%Y%m%d_%H%M%S).mp4
```

FFmpeg will wait for the glasses to connect. Leave this running.

### 4. Start the app

In another terminal:

```bash
bun run dev
```

### 5. Expose with ngrok

In another terminal:

```bash
ngrok http 3000
```

Copy the ngrok URL and update your app's Public URL in the Developer Console.

### 6. Start streaming

Open the Mentra app on your phone and start the stream-test app. The glasses will connect to FFmpeg and start streaming. You'll see "Streaming live" on the glasses display.

When done, stop the app on your phone. Press `Ctrl+C` in the FFmpeg terminal to finalize the MP4 file. Your recording is in the `recordings/` folder.

## Troubleshooting

**FFmpeg says "Connection refused" or nothing happens:**
- Make sure your computer and glasses are on the same WiFi network
- Check that the IP address in `STREAM_URL` is correct
- Make sure port 4201 isn't blocked by a firewall

**Stream starts but FFmpeg shows errors:**
- Try adding `-loglevel debug` to the FFmpeg command to see more detail
- The glasses might need a moment to initialize the camera

**App doesn't connect:**
- Check that your ngrok URL matches the Public URL in the Developer Console
- Make sure you have camera permission on your app

## Using Managed Streaming Instead

If you want to stream through the MentraOS cloud relay (with HLS/WebRTC viewer URLs and restreaming to YouTube/Twitch), change `startStream` in `src/index.ts`:

```typescript
// Direct (current) — glasses → your computer
await session.camera.startStream({ direct: STREAM_URL });

// Managed — glasses → cloud relay → viewer URLs
const stream = await session.camera.startStream();
console.log("Watch at:", stream.hlsUrl);
console.log("WebRTC:", stream.webrtcUrl);

// Managed + restream to YouTube
const stream = await session.camera.startStream({
  destinations: ["rtmp://a.rtmp.youtube.com/live2/your-stream-key"],
});
```
