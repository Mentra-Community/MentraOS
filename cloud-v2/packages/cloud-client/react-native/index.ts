/**
 * @fileoverview The React Native build: `@mentra/cloud-client/react-native`.
 *
 * This is what the mobile app imports. It is a thin wrapper over the shared
 * `CloudClient` that supplies the phone's transports (WebSocket, native UDP,
 * secure storage), so a host only passes `{ endpoints, auth }` and never has to
 * hand-wire sockets.
 *
 * The UDP and secure-storage transports are host-injected (React Native ships
 * neither). The host wires them once at startup via `setNativeUdp` and
 * `setSecureStorage`, which are re-exported here for convenience.
 *
 * See docs/issues/004-cloud-client/design.md ("react-native/index.ts").
 */
import { CloudClient as Base } from "@mentra/cloud-client";
import type { CloudClientConfig } from "@mentra/cloud-client";
import { reactNativeTransports } from "./transports";

/**
 * A `CloudClient` pre-wired with the React Native transports.
 *
 * It takes the config minus `transports` (this build fills those in), so on the
 * phone construction is just `new CloudClient({ endpoints, auth })`.
 */
export class CloudClient extends Base {
  constructor(config: Omit<CloudClientConfig, "transports">) {
    super({ ...config, transports: reactNativeTransports() });
  }
}

// The host wires the phone's native UDP and secure store through these before
// constructing a client that uses UDP audio or token persistence.
export { setNativeHttp, setNativeUdp, setSecureStorage } from "./transports";
export type { NativeUdpFactory } from "./transports";

// Re-export the public surface so a host can import everything (types, errors,
// the logger hook) from the platform build without also reaching for the root.
export * from "@mentra/cloud-client";
