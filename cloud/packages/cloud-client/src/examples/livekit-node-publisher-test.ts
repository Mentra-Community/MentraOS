import { MentraClient } from "../MentraClient";
import { AccountService } from "../services/AccountService";

async function main() {
  const server = process.env.SERVER_URL || "http://localhost:8002";
  const wsServer = server.replace(/^http/, "ws");
  const email = process.env.TEST_EMAIL || "user@example.com";
  const token =
    process.env.CORE_TOKEN ||
    AccountService.generateTestAccount(email).coreToken;

  console.log("🚀 LiveKit Node publisher sanity (rtc-node)");
  console.log("Server:", server);
  console.log("Room  :", email);

  const client = new MentraClient({
    email,
    serverUrl: `${wsServer}`,
    coreToken: token,
    behavior: {
      disableStatusUpdates: true,
      useLiveKitAudio: true,
    },
    debug: { logLevel: "info", logWebSocketMessages: false },
  });

  // Force Node publisher path (no Go bridge)
  client.enableLiveKit({
    useForAudio: true,
    preferredSampleRate: 48000,
    useGoBridge: false,
  });

  let connected = false;
  client.on("livekit_connected", () => {
    console.log("✅ LiveKit connected (rtc-node publisher)");
    connected = true;
  });

  await client.connect();

  // Wait briefly for LiveKit initialization
  let tries = 0;
  while (!connected && tries < 30) {
    await new Promise((r) => setTimeout(r, 100));
    tries++;
  }
  if (!connected) {
    console.error("❌ LiveKit did not connect");
    process.exit(1);
  }

  // Generate and send 3 seconds of 440Hz tone at 16kHz (100ms chunks)
  console.log("📤 Publishing 440Hz tone via rtc-node...");
  const sampleRate = 16000;
  const durationSec = 3;
  const chunks = durationSec * 10; // 10 chunks per second at 100ms
  const numSamples = Math.floor(sampleRate * 0.1);
  const chunk = Buffer.alloc(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.5 * 32767;
    chunk.writeInt16LE(Math.floor(sample), i * 2);
  }

  for (let i = 1; i <= chunks; i++) {
    (client as any).liveKitManager.sendPcmChunk(chunk, sampleRate);
    if (i % 5 === 0) console.log(`   Sent chunk ${i}/${chunks}`);
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log("✅ Done sending. Keep subscriber running to observe energy.");
  await new Promise((r) => setTimeout(r, 1000));
  process.exit(0);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
