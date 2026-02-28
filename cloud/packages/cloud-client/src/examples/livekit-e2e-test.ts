import { MentraClient } from "../MentraClient";
import { AccountService } from "../services/AccountService";
import { resolve } from "path";
import * as fs from "fs";

const APP_PACKAGE_NAME = "isaiah.augmentos.livecaptions";

async function main() {
  const server = process.env.SERVER_URL || "https://isaiah.augmentos.cloud";
  const wsServer = server.replace(/^http/, "ws");
  const email = process.env.TEST_EMAIL || "user@example.com";
  const token =
    process.env.CORE_TOKEN ||
    AccountService.generateTestAccount(email).coreToken;

  console.log("🎯 End-to-End LiveKit Audio Test");
  console.log("================================");
  console.log("Server:", server);
  console.log("Email:", email);
  console.log();

  const client = new MentraClient({
    email,
    serverUrl: `${wsServer}`,
    coreToken: token,
    behavior: {
      disableStatusUpdates: true,
      useLiveKitAudio: true, // Enable LiveKit audio transport
    },
    debug: { logLevel: "info", logWebSocketMessages: false },
  });

  let transcriptionReceived = false;

  client.on("connection_ack", (data) => {
    console.log("✅ CONNECTION_ACK received");
    if (data.livekit) {
      console.log("   LiveKit URL:", data.livekit.url);
      console.log("   Room:", data.livekit.roomName);
    }
  });

  client.on("livekit_connected", () => {
    console.log("✅ LiveKit connected to Go bridge");
  });

  // Listen for transcription events
  client.on("display_event", (event) => {
    console.log("📝 DISPLAY_EVENT received", event);
    if (event.packageName === APP_PACKAGE_NAME) {
      const text =
        event.layout.topText ||
        event.layout.bottomText ||
        event.layout.text ||
        "";
      if (text && text.trim()) {
        console.log("📝 TRANSCRIPTION:", text);
        transcriptionReceived = true;
      }
    }
  });

  client.on("error", (error) => {
    console.error("❌ Error:", error);
  });

  // Connect to server
  console.log("1️⃣  Connecting to server...");
  await client.connect();

  // Wait for LiveKit
  console.log("2️⃣  Waiting for LiveKit connection...");
  // Give bridge + room some time to fully establish
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Install and start transcription app
  console.log("3️⃣  Setting up Live Captions app...");
  try {
    await client.installApp(APP_PACKAGE_NAME);
    console.log("App installed");
  } catch (e) {
    console.log("App already installed", e);
  }

  try {
    await client.stopApp(APP_PACKAGE_NAME);
  } catch {
    // ignore.
  }

  await client.startApp(APP_PACKAGE_NAME);
  console.log("   ✅ App started");

  // Send audio file with VAD signaling (lets cloud authorize and process speech)
  console.log("4️⃣  Sending audio file via LiveKit bridge...");
  const wavPath = resolve(__dirname, "../audio/short-test-16khz.wav");

  if (!fs.existsSync(wavPath)) {
    console.error("❌ Audio file not found:", wavPath);
    process.exit(1);
  }

  // Stream via client helper which sets VAD on/off and streams at proper cadence
  // Stream file (client should route to Go bridge when useLiveKitAudio=true)
  await client.startSpeakingFromFile(wavPath, true);
  console.log("   ✅ Audio streaming triggered");

  // Wait for transcriptions
  console.log("5️⃣  Waiting up to 60s for transcriptions...");
  // Keep the session active for a minute to allow server to process and apps to emit events
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (transcriptionReceived) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Results
  console.log();
  console.log("📊 Results");
  console.log("==========");
  if (transcriptionReceived) {
    console.log("✅ Transcription received successfully!");
    console.log("✅ End-to-end LiveKit audio flow is working!");
  } else {
    console.log("⚠️  No transcriptions received");
    console.log("   This could mean:");
    console.log("   - The transcription service is not running");
    console.log("   - Audio is not flowing through LiveKit properly");
    console.log("   - The app is not subscribed to audio events");
  }

  // Keep connection briefly to flush any final events, then disconnect
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await client.disconnect();
  process.exit(transcriptionReceived ? 0 : 1);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
