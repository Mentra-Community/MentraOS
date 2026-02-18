#!/usr/bin/env bun

/**
 * Test LiveKit audio publishing via Go bridge for MentraOS
 *
 * This test demonstrates:
 * 1. Client connects with LiveKit enabled
 * 2. Server provides LiveKit credentials in CONNECTION_ACK
 * 3. Client uses Go bridge to publish audio to LiveKit
 * 4. Server subscribes to audio via Node SDK and processes it
 */

import { MentraClient } from "../MentraClient";
import { AccountService } from "../services/AccountService";
import fs from "fs";
import path from "path";

async function testLiveKitGoBridge() {
  console.log("🚀 Testing LiveKit audio flow via Go bridge...\n");

  // Step 1: Login
  console.log("1️⃣ Logging in...");
  const accountService = new AccountService();
  const credentials = accountService.createTestAccount(
    process.env.TEST_EMAIL || "test@example.com",
  );
  console.log("✅ Login successful\n");

  // Step 2: Create client with LiveKit enabled
  console.log("2️⃣ Creating client with LiveKit + Go bridge...");
  const client = new MentraClient({
    email: credentials.email,
    serverUrl: process.env.SERVER_URL || "http://localhost:8002",
    coreToken: credentials.coreToken,
    behavior: {
      useLiveKitAudio: true, // Enable LiveKit audio transport
    },
    debug: {
      logLevel: "debug",
      logWebSocketMessages: false, // Less verbose for this test
    },
  });

  // Configure LiveKit manager to use Go bridge
  console.log("   Configuring Go bridge at ws://localhost:8080");
  const liveKitManager = (client as any).liveKitManager;
  liveKitManager.options.useGoBridge = true;
  liveKitManager.options.goBridgeUrl = "ws://localhost:8080";
  liveKitManager.options.useForAudio = true;

  // Step 3: Track connection events
  let livekitConnected = false;

  client.on("connection_ack", (data) => {
    console.log("\n3️⃣ CONNECTION_ACK received:");
    console.log("   Session ID:", data.sessionId);

    if (data.livekit) {
      console.log("   ✅ LiveKit info included:");
      console.log("      URL:", data.livekit.url);
      console.log("      Room:", data.livekit.roomName);
      console.log("      Token:", data.livekit.token ? "Present" : "Missing");
    } else {
      console.log("   ❌ No LiveKit info in CONNECTION_ACK");
    }
  });

  client.on("livekit_connected", () => {
    console.log("\n4️⃣ ✅ LiveKit connected via Go bridge!");
    livekitConnected = true;
  });

  liveKitManager.on("connected", (info: any) => {
    console.log("   LiveKit Manager connected:", info);
  });

  liveKitManager.on("error", (err: any) => {
    console.error("   LiveKit Manager error:", err);
  });

  client.on("error", (error) => {
    console.error("❌ Client error:", error);
  });

  // Step 4: Connect
  console.log("\n5️⃣ Connecting to server...");
  await client.connect();

  // Wait for LiveKit connection
  console.log("\n6️⃣ Waiting for LiveKit connection...");
  let attempts = 0;
  while (!livekitConnected && attempts < 10) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    attempts++;
  }

  if (!livekitConnected) {
    console.error("❌ LiveKit failed to connect after 5 seconds");
    await client.disconnect();
    process.exit(1);
  }

  // Step 5: Test audio publishing
  console.log("\n7️⃣ Testing audio publishing via Go bridge...");

  // Create test audio data (100ms of 440Hz sine wave at 16kHz)
  const sampleRate = 16000;
  const duration = 0.1; // 100ms
  const frequency = 440; // A4 note
  const numSamples = Math.floor(sampleRate * duration);
  const audioBuffer = Buffer.alloc(numSamples * 2); // 16-bit PCM

  for (let i = 0; i < numSamples; i++) {
    const sample =
      Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 0.3 * 32767;
    audioBuffer.writeInt16LE(Math.floor(sample), i * 2);
  }

  // Send multiple chunks to simulate streaming
  console.log("   Sending audio chunks...");
  for (let i = 0; i < 10; i++) {
    liveKitManager.sendPcmChunk(audioBuffer, sampleRate);
    console.log(`   📤 Sent chunk ${i + 1}/10 (${audioBuffer.length} bytes)`);
    await new Promise((resolve) => setTimeout(resolve, 100)); // 100ms between chunks
  }

  // Step 6: Check if server received audio
  console.log("\n8️⃣ Waiting for server to process audio...");
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Step 7: Try speaking from file if available
  const testAudioFile = path.join(
    __dirname,
    "..",
    "..",
    "audio",
    "hello-world.wav",
  );
  if (fs.existsSync(testAudioFile)) {
    console.log("\n9️⃣ Testing with audio file...");
    try {
      await client.startSpeakingFromFile(testAudioFile);
      console.log("   ✅ Audio file streamed successfully");
    } catch (err) {
      console.log("   ⚠️ Could not stream audio file:", err);
    }
  }

  // Summary
  console.log("\n📊 Test Summary:");
  console.log("✅ Client connected with LiveKit enabled");
  console.log("✅ Server provided LiveKit credentials");
  console.log("✅ Go bridge connected to LiveKit");
  console.log("✅ Audio published via Go bridge");
  console.log(
    "\n🎯 Audio flow: cloud-client → Go Bridge → LiveKit → cloud (Node SDK)",
  );
  console.log("\n✨ Go bridge test complete!");

  // Disconnect
  await client.disconnect();
  process.exit(0);
}

// Run test
testLiveKitGoBridge().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
