import WebSocket from "ws";

async function main() {
  // Use a distinct identity for publisher to avoid conflicts
  const userId = process.env.TEST_EMAIL
    ? `diagnostic-publisher:${process.env.TEST_EMAIL}`
    : "diagnostic-publisher:user@example.com";
  const url = process.env.BRIDGE_URL || "ws://localhost:8080/ws";
  const wsUrl = `${url}?userId=${encodeURIComponent(userId)}`;

  console.log("Connecting to bridge:", wsUrl);
  const ws = new WebSocket(wsUrl);

  await new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("timeout")), 5000);
    ws.once("open", () => {
      clearTimeout(to);
      resolve();
    });
    ws.once("error", reject);
  });
  console.log("Connected");

  const server = process.env.SERVER_URL || "http://localhost:8002";
  const res = await fetch(`${server}/api/livekit/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      identity: userId,
      roomName: userId,
      mode: "publish",
    }),
  });
  if (!res.ok) throw new Error(`token http ${res.status}`);
  const { token } = await res.json();

  ws.send(JSON.stringify({ action: "join_room", roomName: userId, token }));
  console.log("Sent join_room");

  // Also instruct bridge to self-generate a 440Hz tone for 3s to rule out upstream issues
  ws.send(JSON.stringify({ action: "publish_tone", freq: 440, ms: 2000 }));

  // Generate 10 chunks of 100ms 440Hz tone at 16k mono PCM16
  const sampleRate = 16000;
  const duration = 0.1;
  const freq = 440;
  const numSamples = Math.floor(sampleRate * duration);
  const chunk = Buffer.alloc(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    const sample =
      Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.5 * 32767;
    chunk.writeInt16LE(Math.floor(sample), i * 2);
  }

  for (let i = 1; i <= 10; i++) {
    ws.send(chunk);
    console.log(`Sent chunk ${i}`);
    await new Promise((r) => setTimeout(r, 100));
  }

  await new Promise((r) => setTimeout(r, 1000));
  ws.close();
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
