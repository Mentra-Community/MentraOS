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
import { meetingsApi } from "./meetings.api";
import {
  createManagedStreamsApi,
  type ManagedStreamsHandle,
} from "./managed-streams.api";
import type { RuntimeServiceName } from "../services/runtime-services";
import { serviceList } from "../services/runtime-services";

export interface CreateApiAppOptions {
  /** Readiness probes surfaced at the health app's `/readyz`. */
  readinessChecks: ReadinessCheck[];
  services?: ReadonlySet<RuntimeServiceName>;
  deploymentManifest?: string;
  legalDocuments?: {
    privacy?: string;
    terms?: string;
  };
}

export interface ApiAppHandle {
  app: Hono;
  stop(): Promise<void>;
}

/** Build the runtime's HTTP app. Called once at boot in `index.ts`. */
export function createApiApp(opts: CreateApiAppOptions): ApiAppHandle {
  const app = new Hono();
  const services =
    opts.services ??
    new Set<RuntimeServiceName>([
      "realtime-audio",
      "managed-photos",
      "managed-streams",
      "maps",
      "tts",
    ]);
  let managedStreams: ManagedStreamsHandle | undefined;

  if (services.has("realtime-audio")) app.route("/api/audio", audioApi);
  if (services.has("managed-photos")) app.route("/api/camera", cameraApi);
  if (services.has("managed-streams") && !services.has("managed-photos")) {
    managedStreams = createManagedStreamsApi();
    app.route("/api/camera", managedStreams.api);
  }
  if (services.has("maps")) app.route("/api/maps", mapsApi);
  if (services.has("tts")) app.route("/api/tts", ttsApi);
  if (services.has("meetings")) app.route("/api/meetings", meetingsApi);

  if (opts.deploymentManifest) {
    const deploymentManifest = opts.deploymentManifest;
    app.get("/.well-known/mentra-deployment.json", (c) =>
      c.body(deploymentManifest, 200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      }),
    );
  }

  if (opts.legalDocuments?.privacy) {
    const privacy = opts.legalDocuments.privacy;
    app.get("/legal/privacy", (c) => c.html(privacy));
  }
  if (opts.legalDocuments?.terms) {
    const terms = opts.legalDocuments.terms;
    app.get("/legal/terms", (c) => c.html(terms));
  }

  // Health/readiness routes (/healthz, /readyz). Mounted at the root so its
  // own paths are unchanged.
  const health = createHealthApp({
    packageName: "runtime",
    readinessChecks: opts.readinessChecks,
    details: { services: serviceList(services) },
  });
  app.route("/", health);

  return {
    app,
    async stop() {
      await managedStreams?.stop();
    },
  };
}
