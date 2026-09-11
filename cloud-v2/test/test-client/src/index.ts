/**
 * `@mentra/test-client` — reference client for cloud-v2 end-to-end tests and
 * hand-driven exploration. Re-exports the `TestClient` class from `./client`.
 *
 * Hand-runnable form (when invoked directly):
 *   bun test/test-client/src/index.ts <tenantUserId>
 *
 * Pings the local stack: TEST OEM (:3100) → core (:3000) → audio (:3001 WS),
 * completes the connection.init/ack handshake, sends one fake-LC3 UDP packet,
 * prints what the cloud reports back when `AUDIO_DEBUG_ECHO=true` is set.
 */

export { TestClient, type TestClientOptions, type ConnectionAck } from "./client";

import { TestClient } from "./client";

const isMain = import.meta.main;
if (isMain) {
  const tenantUserId = process.argv[2] ?? "tc-alice";
  const client = new TestClient({
    testOemUrl: process.env.TEST_OEM_URL ?? "http://localhost:3100",
    coreUrl: process.env.CORE_URL ?? "http://localhost:3000",
    audioWsUrl: process.env.AUDIO_WS_URL ?? "ws://localhost:3001/ws/session",
    tenantUserId,
  });
  await client.connect();
  console.log("connected; sessionTag =", client.sessionTag);
  client.sendAudio(new Uint8Array(40)); // 40 bytes of zeros — looks like an LC3 frame
  // Give the cloud a moment to receive + echo back if AUDIO_DEBUG_ECHO is on.
  await new Promise((r) => setTimeout(r, 500));
  console.log("messages received:", client.messages);
  await client.close();
}
