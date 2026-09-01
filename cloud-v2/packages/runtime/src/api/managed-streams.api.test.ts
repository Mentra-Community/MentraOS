import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetRuntimeAuthCache, signRuntimeToken } from "@mentra/cloud-shared";
import type { StreamProvider } from "../services/stream/stream.service";
import { createManagedStreamsApi } from "./managed-streams.api";

let privateKey: string;

beforeEach(() => {
  const keys = crypto.generateKeyPairSync("ed25519");
  privateKey = stripPem(
    keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  process.env.TEST_RUNTIME_PUBLIC_KEY = stripPem(
    keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  );
  process.env.CLOUD_RUNTIME_AUTH_ISSUERS = JSON.stringify([
    {
      issuer: "managed-stream-test",
      publicKeyEnv: "TEST_RUNTIME_PUBLIC_KEY",
      fixedTenantId: "tenant-1",
    },
  ]);
  resetRuntimeAuthCache();
});

afterEach(() => {
  delete process.env.TEST_RUNTIME_PUBLIC_KEY;
  delete process.env.CLOUD_RUNTIME_AUTH_ISSUERS;
  resetRuntimeAuthCache();
});

describe("managed stream API", () => {
  test("preserves the camera contract and enforces owner access", async () => {
    const calls: string[] = [];
    const provider: StreamProvider = {
      name: "test",
      async provision() {
        calls.push("provision");
        return {
          streamId: "stream-1",
          ingest: { webrtcPublishUrl: "https://publish.invalid/whip" },
          playback: { webrtc: "https://watch.invalid/whep" },
        };
      },
      async status(streamId) {
        calls.push(`status:${streamId}`);
        return { streamId, isConnected: true, state: "live" };
      },
      async stop(streamId) {
        calls.push(`stop:${streamId}`);
        return { recordings: 0, input: "deleted" };
      },
    };
    const handle = createManagedStreamsApi({
      provider,
      sweepIntervalMs: 60_000,
    });
    const ownerToken = await tokenFor("user-1");
    const otherToken = await tokenFor("user-2");

    const created = await handle.api.request("/stream", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ streamId: "stream-1" });

    const denied = await handle.api.request("/stream/stream-1", {
      headers: { Authorization: `Bearer ${otherToken}` },
    });
    expect(denied.status).toBe(404);

    const status = await handle.api.request("/stream/stream-1", {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ isConnected: true });

    const stopped = await handle.api.request("/stream/stream-1", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(stopped.status).toBe(200);
    expect(calls).toEqual(["provision", "status:stream-1", "stop:stream-1"]);
    await handle.stop();
  });

  test("does not overwrite a stream created while startup discovery is in flight", async () => {
    let finishDiscovery!: (value: {
      inputs: Array<{ streamId: string; createdAt: number }>;
      truncated: boolean;
    }) => void;
    const discovery = new Promise<{
      inputs: Array<{ streamId: string; createdAt: number }>;
      truncated: boolean;
    }>((resolve) => {
      finishDiscovery = resolve;
    });
    const provider: StreamProvider = {
      name: "test",
      async provision() {
        return {
          streamId: "stream-race",
          ingest: { webrtcPublishUrl: "https://publish.invalid/whip" },
          playback: { webrtc: "https://watch.invalid/whep" },
        };
      },
      async status(streamId) {
        return { streamId, isConnected: true, state: "live" };
      },
      async stop() {
        return { recordings: 0, input: "deleted" };
      },
      discover() {
        return discovery;
      },
    };
    const handle = createManagedStreamsApi({
      provider,
      sweepIntervalMs: 60_000,
    });
    const ownerToken = await tokenFor("user-1");

    const created = await handle.api.request("/stream", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(created.status).toBe(200);

    finishDiscovery({
      inputs: [{ streamId: "stream-race", createdAt: Date.now() }],
      truncated: false,
    });
    await discovery;
    await Promise.resolve();

    const status = await handle.api.request("/stream/stream-race", {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(status.status).toBe(200);
    await handle.stop();
  });
});

async function tokenFor(subject: string): Promise<string> {
  return signRuntimeToken({
    privateKey,
    issuer: "managed-stream-test",
    subject,
    tenantId: "ignored-fixed-tenant",
    expiresInSeconds: 60,
  });
}

function stripPem(pem: string): string {
  return pem
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "");
}
