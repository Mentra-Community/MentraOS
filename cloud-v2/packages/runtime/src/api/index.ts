/**
 * @fileoverview The runtime's REST surface (Hono), composed into one app.
 *
 * `index.ts` serves this for any HTTP request that isn't a WebSocket upgrade.
 * It mounts each service's routes plus the shared health app:
 *   - /api/audio/*  -> audio.api (subscriptions)
 *   - /api/camera/* -> camera.api (managed photo + stream, later)
 *   - /api/maps/*   -> maps.api (directions + reverse geocoding)
 *   - /api/tts/*    -> tts.api (streaming speech synthesis)
 *   - /healthz, /readyz, ... -> the shared health app
 *
 * Client-initiated commands are REST (stateless, pod-agnostic) per the runtime
 * protocol; the WebSocket stays a downstream push channel. See
 * docs/issues/002-cloud-runtime/protocol.md ("Channels").
 */

import { Hono } from "hono";
import { createHealthApp, type ReadinessCheck } from "@mentra/cloud-shared";
import { audioApi } from "./audio.api";
import { cameraApi } from "./camera.api";
import { mapsApi } from "./maps.api";
import { ttsApi } from "./tts.api";

export interface CreateApiAppOptions {
  /** Readiness probes surfaced at the health app's `/readyz`. */
  readinessChecks: ReadinessCheck[];
}

/** Build the runtime's HTTP app. Called once at boot in `index.ts`. */
export function createApiApp(opts: CreateApiAppOptions): Hono {
  const app = new Hono();

  app.route("/api/audio", audioApi);
  app.route("/api/camera", cameraApi);
  app.route("/api/maps", mapsApi);
  app.route("/api/tts", ttsApi);

  // Health/readiness routes (/healthz, /readyz). Mounted at the root so its
  // own paths are unchanged.
  const health = createHealthApp({
    packageName: "audio",
    readinessChecks: opts.readinessChecks,
  });
  app.route("/", health);

  return app;
}
