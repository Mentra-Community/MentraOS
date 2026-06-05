/**
 * @fileoverview Multi-pod test harness.
 *
 * Spawns real `cloud-audio` subprocesses (one per simulated K8s pod) so
 * integration tests can exercise the architecture under its actual operating
 * conditions — separate OS processes, separate module state, separate port
 * bindings, only Redis shared. Mirrors what Porter / K8s does in prod.
 *
 * Each pod gets its own env: PORT, AUDIO_UDP_PORT, POD_ID, advertise host/port,
 * etc. Inherits MENTRA_JWT_PUBLIC_KEY, REDIS_URL, LOG_LEVEL from parent test
 * process.
 */

import type { Subprocess } from "bun";

export interface SpawnAudioPodOptions {
  podId: string;
  httpPort: number;
  udpPort: number;
  /** Host advertised in connection.ack. Default `127.0.0.1`. */
  udpAdvertisedHost?: string;
  /** Port advertised in connection.ack. Default matches `udpPort`. */
  udpAdvertisedPort?: number;
  /** Default: inherits from parent process. */
  redisUrl?: string;
  /** Whether the pod should echo `UDP_PACKET_RECEIVED` back on its WS. */
  audioDebugEcho?: boolean;
  /** Hard timeout to wait for /healthz to come up. Default 10s. */
  readyTimeoutMs?: number;
  /** Capture stdout/stderr instead of inheriting. Useful for debugging tests. */
  captureOutput?: boolean;
}

export interface PodHandle {
  podId: string;
  httpPort: number;
  udpPort: number;
  wsUrl: string;
  url: string;
  udpAddr: { host: string; port: number };
  process: Subprocess;
  /** Send SIGTERM, wait for clean exit (with a SIGKILL fallback). */
  kill(): Promise<void>;
}

const CLOUD_V2_ROOT = new URL("../..", import.meta.url).pathname;

export async function spawnAudioPod(
  opts: SpawnAudioPodOptions,
): Promise<PodHandle> {
  const advertisedHost = opts.udpAdvertisedHost ?? "127.0.0.1";
  const advertisedPort = opts.udpAdvertisedPort ?? opts.udpPort;

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PORT: String(opts.httpPort),
    AUDIO_UDP_PORT: String(opts.udpPort),
    AUDIO_UDP_ADVERTISED_HOST: advertisedHost,
    AUDIO_UDP_ADVERTISED_PORT: String(advertisedPort),
    POD_ID: opts.podId,
    AUDIO_DEBUG_ECHO: opts.audioDebugEcho ? "true" : "false",
  };
  if (opts.redisUrl) env.REDIS_URL = opts.redisUrl;

  const proc = Bun.spawn(
    ["bun", "packages/runtime/src/index.ts"],
    {
      cwd: CLOUD_V2_ROOT,
      env,
      stdout: opts.captureOutput ? "pipe" : "inherit",
      stderr: opts.captureOutput ? "pipe" : "inherit",
    },
  );

  // Don't keep the parent process alive on this child.
  // (Bun.spawn doesn't unref by default; the test process won't exit until
  // children do — but we manage that explicitly via kill().)

  await waitForHealthz(opts.httpPort, opts.readyTimeoutMs ?? 10_000, proc);

  return {
    podId: opts.podId,
    httpPort: opts.httpPort,
    udpPort: opts.udpPort,
    wsUrl: `ws://localhost:${opts.httpPort}/ws/session`,
    url: `http://localhost:${opts.httpPort}`,
    udpAddr: { host: "127.0.0.1", port: opts.udpPort },
    process: proc,
    async kill() {
      proc.kill("SIGTERM");
      try {
        await withTimeout(proc.exited, 3000);
      } catch {
        proc.kill("SIGKILL");
        await proc.exited;
      }
    },
  };
}

async function waitForHealthz(
  port: number,
  timeoutMs: number,
  proc: Subprocess,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(
        `audio pod exited during boot with code ${proc.exitCode}`,
      );
    }
    try {
      const res = await fetch(`http://localhost:${port}/healthz`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await Bun.sleep(100);
  }
  throw new Error(`audio pod on :${port} did not become healthy in ${timeoutMs}ms`);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
