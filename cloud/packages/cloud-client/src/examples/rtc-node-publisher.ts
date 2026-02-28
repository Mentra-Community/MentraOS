import { setTimeout as delay } from "timers/promises";

async function mintPublishToken(
  serverHttp: string,
  identity: string,
  roomName: string,
) {
  const res = await fetch(`${serverHttp}/api/livekit/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity, roomName, mode: "publish" }),
  });
  if (!res.ok) throw new Error(`Token mint failed: ${res.status}`);
  const json = await res.json();
  if (!json?.url || !json?.token) throw new Error("Invalid token response");
  return json as { url: string; token: string };
}

async function main() {
  const server = process.env.SERVER_URL || "http://localhost:8002";
  const email = process.env.TEST_EMAIL || "user@example.com";
  const serverHttp = server.replace(/^ws/, "http");

  console.log("[Pub] rtc-node publisher");
  console.log("Server:", serverHttp);
  console.log("Room  :", email);

  const { url, token } = await mintPublishToken(
    serverHttp,
    `rtc-node-pub:${email}`,
    email,
  );

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    Room,
    AudioSource,
    LocalAudioTrack,
    TrackSource,
  } = require("@livekit/rtc-node");

  const room = new Room();
  await room.connect(url, token, { autoSubscribe: false, timeout: 10000 });
  console.log("[Pub] ✅ Connected to LiveKit as publisher");

  const targetRate = 48000;
  const source = new AudioSource({ sampleRate: targetRate, numChannels: 1 });
  const track = LocalAudioTrack.createAudioTrack("rtc-node-tone", {
    source,
    sourceType: TrackSource.Microphone,
  });
  await room.localParticipant.publishTrack(track);
  console.log("[Pub] ✅ Track published");

  // Generate 10ms 440Hz tone frames for 3 seconds
  const samplesPer10ms = Math.floor(targetRate / 100);
  const totalFrames = 300; // 3s at 100 frames/sec

  for (let f = 0; f < totalFrames; f++) {
    const frame = new Int16Array(samplesPer10ms);
    for (let i = 0; i < samplesPer10ms; i++) {
      const t = f * samplesPer10ms + i;
      const sample =
        Math.sin((2 * Math.PI * 440 * t) / targetRate) * 0.5 * 32767;
      frame[i] = Math.floor(sample);
    }
    const audioFrame = {
      data: frame,
      sampleRate: targetRate,
      numChannels: 1,
      samplesPerChannel: frame.length,
    };
    if (typeof source.captureFrame === "function")
      source.captureFrame(audioFrame);
    else if (typeof source.pushFrame === "function")
      (source as any).pushFrame(audioFrame);
    await delay(10);
  }

  console.log("[Pub] ✅ Done sending tone");
  try {
    room.disconnect();
  } catch {
    // ignore.
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
