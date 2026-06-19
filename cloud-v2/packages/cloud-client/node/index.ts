/**
 * @fileoverview The `@mentra/cloud-client/node` build: a server-wired CloudClient.
 *
 * This is the import the backend test harness and the dev stack use. It is a
 * thin wrapper over the shared `CloudClient`: it pre-wires the Node transports
 * (the `ws` package, `dgram`, and an in-memory store) so a caller passes only
 * `{ endpoints, auth, ... }` and never has to hand-build sockets. The shared
 * logic lives entirely in the root build; nothing platform-specific leaks past
 * this file.
 *
 * See docs/issues/004-cloud-client/design.md ("node/index.ts").
 */
import { CloudClient as Base } from "@mentra/cloud-client";
import type { CloudClientConfig } from "@mentra/cloud-client";
import { nodeTransports } from "./transports";

/**
 * A `CloudClient` with the Node transports already supplied.
 *
 * The constructor takes the full config minus `transports`: the platform build
 * owns that piece, so a host cannot accidentally pass server sockets to the
 * device build or vice versa. We forward everything else through unchanged and
 * inject a fresh transport bundle on construction.
 */
export class CloudClient extends Base {
  constructor(config: Omit<CloudClientConfig, "transports">) {
    super({ ...config, transports: nodeTransports() });
  }
}

// Re-export the public surface so a host can import the client and the types it
// needs from the single `@mentra/cloud-client/node` entry, matching the device
// build's ergonomics.
export type {
  CloudClientConfig,
  AuthConfig,
  SubjectTokenType,
  CloudClientTransports,
  WebSocketLike,
  UdpSocketLike,
  KeyValueStore,
  Logger,
  RuntimeAudioTransport,
  RuntimeSnapshot,
  RuntimeStatus,
  RuntimeTtsSpeakOptions,
  RuntimeTtsSpeechSource,
} from "@mentra/cloud-client";
export {
  CloudClientError,
  HttpError,
  AuthExpiredError,
  noopLogger,
} from "@mentra/cloud-client";
