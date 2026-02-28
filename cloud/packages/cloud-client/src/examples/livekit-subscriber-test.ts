import { setTimeout as delay } from "timers/promises";

async function mintSubscribeToken(
  serverHttp: string,
  identity: string,
  roomName: string,
) {
  const body = { identity, roomName, mode: "subscribe" };
  const headers = { "Content-Type": "application/json" } as Record<
    string,
    string
  >;
  const path = "/api/livekit/token";
  const res = await fetch(`${serverHttp}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
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

  console.log("[Test] LiveKit subscriber sanity check");
  console.log("Server:", serverHttp);
  console.log("Room  :", email);

  const { url, token } = await mintSubscribeToken(
    serverHttp,
    `sanity-subscriber:${email}`,
    email,
  );

  // Lazy-require to avoid ESM issues
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    Room,
    RoomEvent,
    AudioStream,
    TrackKind,
  } = require("@livekit/rtc-node");

  const room = new Room();
  await room.connect(url, token, { autoSubscribe: true, timeout: 10000 });
  console.log("[Test] ✅ Connected to LiveKit as subscriber");

  let frames = 0;
  let samples = 0;
  let sumAbs = 0;
  let sumSq = 0;
  let sr: number | undefined;
  let ch: number | undefined;
  let sampleType: "int16" | "float32" | "unknown" = "unknown";

  const stopAt = Date.now() + 8000;

  room.on(
    RoomEvent.TrackSubscribed,
    async (track: any, _pub: any, participant: any) => {
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      console.log("[Test] 🎧 Subscribed to audio from", participant.identity);
      const stream = new AudioStream(track);
      for await (const frame of stream) {
        frames++;
        sr = (frame as any).sampleRate ?? 48000;
        ch = (frame as any).channels ?? (frame as any).channelCount ?? 1;
        if (!ch) continue;

        const dataAny: any = (frame as any).data ?? frame.data;
        let monoInt16: Int16Array;
        if (dataAny instanceof Int16Array) {
          sampleType = "int16";
          if (ch === 1) monoInt16 = dataAny;
          else {
            const totalFrames = Math.floor(dataAny.length / ch);
            monoInt16 = new Int16Array(totalFrames);
            for (let i = 0; i < totalFrames; i++) {
              let acc = 0;
              for (let c = 0; c < ch; c++) acc += dataAny[i * ch + c];
              monoInt16[i] = Math.max(
                -32768,
                Math.min(32767, Math.round(acc / ch)),
              );
            }
          }
        } else if (dataAny instanceof Float32Array) {
          sampleType = "float32";
          const totalFrames = Math.floor(dataAny.length / ch);
          monoInt16 = new Int16Array(totalFrames);
          for (let i = 0; i < totalFrames; i++) {
            let acc = 0;
            for (let c = 0; c < ch; c++) acc += dataAny[i * ch + c];
            const avg = acc / ch;
            monoInt16[i] = Math.max(
              -32768,
              Math.min(32767, Math.round(avg * 32767)),
            );
          }
        } else {
          sampleType = "unknown";
          const bufView = new Int16Array(
            (dataAny?.buffer as ArrayBuffer) || frame.data.buffer,
          );
          monoInt16 = bufView;
        }

        samples += monoInt16.length;
        for (let i = 0; i < monoInt16.length; i++) {
          const v = monoInt16[i];
          sumAbs += Math.abs(v);
          sumSq += v * v;
        }
        if (Date.now() > stopAt) break;
      }
    },
  );

  while (Date.now() < stopAt) {
    await delay(200);
  }

  try {
    room.disconnect();
  } catch {
    // ignore.
  }

  const meanAbs = samples ? sumAbs / samples : 0;
  const rms = samples ? Math.sqrt(sumSq / samples) : 0;

  console.log("[Test] —— Results ——");
  console.log("[Test] Frames     :", frames);
  console.log("[Test] SampleRate :", sr);
  console.log("[Test] Channels   :", ch);
  console.log("[Test] Samples    :", samples);
  console.log("[Test] MeanAbs    :", meanAbs.toFixed(1));
  console.log("[Test] RMS        :", rms.toFixed(1));
  console.log("[Test] SampleType :", sampleType);

  if (frames === 0 || samples === 0) {
    console.error("[Test] ❌ No audio frames received");
    process.exit(2);
  }
  if (rms < 50 && meanAbs < 25) {
    console.error("[Test] ⚠️ Audio energy very low (near-silence)");
    process.exit(3);
  }
  console.log("[Test] ✅ Audio present with non-trivial energy");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
