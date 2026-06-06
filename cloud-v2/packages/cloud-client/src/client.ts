/**
 * @fileoverview The top-level `CloudClient`: wiring only, no behavior.
 *
 * `new CloudClient(config)` resolves the server addresses (proxy-aware), builds
 * the shared REST helpers, and constructs the three modules in dependency order
 * (auth first, since runtime and core both pull their Bearer through it). All the
 * actual logic lives in the modules under `./modules/**`; this file just hands
 * each one its dependencies and exposes the three modules as readonly fields.
 *
 * It also owns the two cross-cutting concerns the design says belong in one
 * place: the logger (so a host has a single hook for every module's logs) and the
 * reconnect/backoff settings (so the live socket's timing is tuned here, not
 * scattered across the runtime internals).
 *
 * See docs/issues/004-cloud-client/design.md ("The top-level CloudClient").
 */
import { noopLogger } from "./logger";
import type { Logger } from "./logger";
import type { CloudClientConfig } from "./config";
import { createHttpClient } from "./http";
import type { ConnectionInit } from "@mentra/cloud-runtime/protocol";

// The module implementations. Each is owned by another agent under ./modules/**;
// this file only constructs them, matching the constructor signatures fixed in
// design.md exactly.
import { Auth } from "./modules/auth/auth";
import { TokenStore } from "./modules/auth/token-store";
import { Runtime } from "./modules/runtime/runtime";
import { Connection } from "./modules/runtime/connection";
import { RuntimeEmitter } from "./modules/runtime/emitter";
import { Subscriptions } from "./modules/runtime/subscriptions";
import { Camera } from "./modules/runtime/camera";
import { UdpAudio } from "./modules/runtime/audio-udp";
import { Core } from "./modules/core/core";

/**
 * Default reconnect/backoff for the live socket when a host supplies none.
 *
 * One second base, capped at thirty, with jitter on: jitter keeps a fleet of
 * phones from reconnecting in lockstep after a shared cloud blip. A host can
 * override any of these through `config.reconnect`.
 */
const DEFAULT_RECONNECT = { baseMs: 1_000, maxMs: 30_000, jitter: true };

/**
 * The default audio codec the client announces in the handshake.
 *
 * LC3 at 16 kHz matches the glasses' on-device codec, so the cloud transcribes
 * the same bytes the device captures. A future config knob can override this; for
 * now the handshake announces the device default so audio that starts immediately
 * after connect is decoded correctly.
 */
const DEFAULT_AUDIO_CODEC = "lc3" as const;
const DEFAULT_AUDIO_SAMPLE_RATE = 16_000;

/**
 * The protocol semver this client build speaks, announced in `connection.init`.
 *
 * Hardcoded to the 2.x line this package targets; bumped here when the client
 * starts speaking a newer protocol build, so there is one place to change it.
 */
const PROTOCOL_VERSION = "2.0.0";

/**
 * Rewrite a base URL to route through a proxy host while preserving its path.
 *
 * When a host sets `endpoints.proxy`, both the core and runtime addresses go
 * through that one host (for example a dev-stack tunnel or a debugging relay). We
 * swap only the origin (scheme + host + port) and keep the original path, so a
 * core/runtime address that carries a path prefix is not lost when proxied.
 */
function rewriteThroughProxy(target: string, proxy: string): string {
  const proxyUrl = new URL(proxy);
  const targetUrl = new URL(target);
  // Keep the target's path/query, take the proxy's origin.
  targetUrl.protocol = proxyUrl.protocol;
  targetUrl.host = proxyUrl.host;
  return targetUrl.toString();
}

/**
 * Derive the runtime WebSocket URL from its HTTP base.
 *
 * `endpoints.runtime` is the HTTP origin the REST calls use; the live session
 * rides a WebSocket at the runtime's `/ws/session` path. So we swap the scheme
 * (http -> ws, https -> wss) and append that path. Keeping this here (not in the
 * Connection) means the Connection stays transport-URL-agnostic and the one
 * place that knows the runtime's HTTP shape also derives its socket URL.
 */
function toRuntimeWsUrl(httpBase: string): string {
  const u = new URL(httpBase);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = `${u.pathname.replace(/\/$/, "")}/ws/session`;
  return u.toString();
}

export class CloudClient {
  // Typed as the concrete module classes rather than separate `AuthModule` /
  // `RuntimeModule` / `CoreModule` interfaces: each class IS the implementation
  // of its public contract (per design.md), so a host gets the full, typed
  // surface (`cloud.auth.getAccessToken()`, etc.) straight off these fields with
  // no parallel interface to keep in sync.
  readonly auth: Auth;
  readonly runtime: Runtime;
  readonly core: Core;

  constructor(config: CloudClientConfig) {
    // One logger for the whole client, so a host routes every module's logs in
    // one place. Default to the silent no-op so we never print uninvited.
    const logger: Logger = config.logger ?? noopLogger;

    // Reconnect/backoff lives here so the socket's timing is tuned in one spot.
    const reconnect = config.reconnect ?? DEFAULT_RECONNECT;

    // Resolve the two base addresses. With a proxy set, both route through it;
    // without one, each module talks to its own service directly.
    const { core: coreBase, runtime: runtimeBase, proxy } = config.endpoints;
    const coreUrl = proxy ? rewriteThroughProxy(coreBase, proxy) : coreBase;
    const runtimeUrl = proxy
      ? rewriteThroughProxy(runtimeBase, proxy)
      : runtimeBase;

    // Build auth FIRST: runtime and core both source their Bearer from it, so it
    // has to exist before their HTTP helpers can reference `getAccessToken`.
    //
    // Auth's own HTTP helper has no default token source: its `/exchange` and
    // `/refresh` calls present the subject and refresh tokens via `opts.bearer`,
    // before any access token exists. It talks to the core service.
    const authHttp = createHttpClient({ baseUrl: coreUrl, logger });
    const store = new TokenStore({ storage: config.transports.storage });
    const auth = new Auth({
      http: authHttp,
      store,
      config: config.auth,
      logger,
      // The form-encoded `/exchange` and `/refresh` calls go through `fetch`
      // directly (not the JSON `HttpClient`), so Auth needs the core base URL.
      baseUrl: coreUrl,
    });

    // Both the core and runtime HTTP helpers use auth as their default Bearer
    // source, so every resource call carries a fresh (auto-refreshed) access
    // token. `getAccessToken` is bound so it keeps `auth` as its receiver.
    const getAccessToken = (): Promise<string> => auth.getAccessToken();

    const coreHttp = createHttpClient({
      baseUrl: coreUrl,
      getToken: getAccessToken,
      logger,
    });
    const runtimeHttp = createHttpClient({
      baseUrl: runtimeUrl,
      getToken: getAccessToken,
      logger,
    });

    // The handshake payload the connection sends on every (re)open. It is a
    // factory (not a fixed value) so each reconnect re-reads the current defaults
    // rather than reusing a stale snapshot. The token is omitted here: the
    // connection attaches the live access token itself via `getToken`, so the
    // payload never carries a credential that could go stale between reopens.
    const initPayload = (): ConnectionInit => ({
      protocolVersion: PROTOCOL_VERSION,
      audio: {
        codec: config.audio?.codec ?? DEFAULT_AUDIO_CODEC,
        sampleRate: config.audio?.sampleRate ?? DEFAULT_AUDIO_SAMPLE_RATE,
      },
    });

    // Build the runtime's five pieces, then the runtime that orchestrates them.
    const connection = new Connection({
      ws: config.transports.ws,
      url: toRuntimeWsUrl(runtimeUrl),
      getToken: getAccessToken,
      initPayload,
      reconnect,
      logger,
    });
    const emitter = new RuntimeEmitter();
    const subscriptions = new Subscriptions({ http: runtimeHttp });
    const camera = new Camera({ http: runtimeHttp });
    const audio = new UdpAudio({ udp: config.transports.udp });

    const runtime = new Runtime({
      connection,
      emitter,
      subscriptions,
      camera,
      audio,
      logger,
      // On a fatal AUTH_EXPIRED at handshake, runtime forces auth to drop its
      // cached access token and refresh; the connection then re-reads the fresh
      // token via getAccessToken on the reopen.
      forceRefreshToken: () => auth.getAccessToken({ forceRefresh: true }),
    });

    // Core is last: stateless REST on the core service, Bearer from auth.
    const core = new Core({ http: coreHttp });

    this.auth = auth;
    this.runtime = runtime;
    this.core = core;
  }
}
