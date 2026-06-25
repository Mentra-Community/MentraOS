/**
 * @fileoverview The config you pass to `new CloudClient(...)`.
 *
 * This is the public construction contract. The platform-specific wrappers
 * (`react-native`, `node`) supply `transports` for you, so a host using one of
 * those imports passes everything here except `transports`.
 *
 * See docs/issues/004-cloud-client/spec.md ("Construction") and design.md.
 */
import type { Logger } from "./logger";
import type { CloudClientTransports } from "./transports";

/**
 * The full shape passed to the root `CloudClient`.
 *
 * `endpoints.proxy`, when set, rewrites BOTH the core and runtime addresses to
 * route through one host. We keep it as a single optional field (rather than two
 * pre-rewritten URLs) so a host configures the proxy in one place and cannot get
 * the two halves out of sync.
 */
export interface CloudClientConfig {
  // `core` is optional only for runtime-only deployments. If `auth.core` is set,
  // or if `auth.runtime.source` is `"core"`, this must be present; Core/Auth
  // calls are never routed to Runtime.
  endpoints: { core?: string; runtime: string; proxy?: string };
  auth: AuthConfig;
  transports: CloudClientTransports;
  logger?: Logger;
  // backoff tuning for the live socket; one place so a host can match its fleet
  reconnect?: { baseMs: number; maxMs: number; jitter: boolean };
  /**
   * Audio format announced in `connection.init`. Defaults to PCM at 16 kHz when
   * omitted. An LC3 host MUST pass the frame size its encoder emits — the
   * runtime sizes its decoder from this field, and phone builds legitimately
   * differ (20/40/60); there is no safe default, so the type requires it.
   */
  audio?:
    | { codec: "pcm"; sampleRate?: number }
    | { codec: "lc3"; sampleRate?: number; frameSizeBytes: 20 | 40 | 60 };
}

/**
 * Which kind of subject token the host is exchanging for a Mentra access token.
 *
 * The cloud's `/exchange` endpoint needs to know how to verify the incoming
 * token, so the type travels alongside the token itself.
 */
export type SubjectTokenType = "oem-jwt" | "mentra-core" | "supabase";

/**
 * The three ways a host can give the client its credentials.
 *
 * The variants exist so a host hands over only what it has: a raw subject token
 * to exchange once, a callback that fetches one on demand (for tokens that
 * themselves expire), or an already-exchanged access/refresh pair (for example
 * restored from secure storage on relaunch).
 */
export type CoreAuthConfig =
  // exchanged once on first use
  | { subjectToken: string; subjectTokenType: SubjectTokenType }
  // fetched on demand, for subject tokens that expire before exchange
  | { getSubjectToken: () => Promise<{ token: string; type: SubjectTokenType }> }
  // already exchanged, skip straight to refresh
  | { accessToken: string; refreshToken: string };

export type RuntimeAuthConfig =
  | {
      /**
       * Ask Cloud Core/Auth to mint a short-lived `cloud-runtime` token. This is
       * explicit hosted-Core mode, not an implicit Core-token fallback.
       */
      source: "core";
    }
  | {
      /** Host/OEM/local-dev supplied runtime-token provider. */
      getToken(opts?: { forceRefresh?: boolean }): Promise<string>;
    };

export interface AuthConfig {
  // Core-backed auth owns identity, Core token exchange/refresh, miniapp token
  // minting, and miniapp auto-auth. Omit only for true runtime-only deployments.
  core?: CoreAuthConfig;
  runtime: RuntimeAuthConfig;
}
