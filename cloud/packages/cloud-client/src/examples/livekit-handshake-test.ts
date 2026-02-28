import { MentraClient } from "../MentraClient";
import { AccountService } from "../services/AccountService";
import { resolve } from "path";

// const TRANSLATION_PACKAGE_NAME = 'com.mentra.translation';
const APP_PACKAGE_NAME = "isaiah.augmentos.livecaptions";

async function main() {
  // Defaults to public ngrok tunnel for cloud
  const server = process.env.SERVER_URL || "https://isaiah.augmentos.cloud";
  const wsServer = server.replace(/^http/, "ws");
  const email = process.env.TEST_EMAIL || "user@example.com";
  const token =
    process.env.CORE_TOKEN ||
    AccountService.generateTestAccount(email).coreToken;

  const client = new MentraClient({
    email,
    serverUrl: `${wsServer}`,
    coreToken: token,
    behavior: {
      disableStatusUpdates: true,
      useLiveKitAudio: true, // Enable LiveKit audio transport
    },
    debug: { logLevel: "info", logWebSocketMessages: true },
  });

  client.on("livekit_connected", () => {
    console.log("[Example] ✅ LiveKit connected successfully!");
  });

  // Listen for transcription events
  client.on("display_event", (event) => {
    if (event.packageName === APP_PACKAGE_NAME) {
      console.log(
        "[Example] 📝 Transcription:",
        event.layout.topText || event.layout.bottomText,
      );
    }
  });

  // Add error handling for LiveKit
  client.on("error", (error) => {
    console.error("[Example] Client error:", error);
  });

  await client.connect();

  // Ensure Live Captions is installed and running
  try {
    await client.installApp(APP_PACKAGE_NAME);
  } catch {
    console.error("[Example] Failed to install Live Captions app");
  }
  try {
    await client.stopApp(APP_PACKAGE_NAME);
  } catch {
    console.error("[Example] Failed to stop Live Captions app");
  }
  await client.startApp(APP_PACKAGE_NAME);

  // Use a shorter audio file for testing
  const wavPath = resolve(__dirname, "../audio/what-time-is-it.wav");

  console.log("[Example] Waiting for LiveKit to connect via CONNECTION_ACK...");

  // Wait for LiveKit to initialize via CONNECTION_ACK
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Use existing speak flow (VAD + streaming) which now routes audio via LiveKit
  await client.startSpeakingFromFile(wavPath);

  // The Live Captions app will emit transcription display events as they arrive
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
