/**
 * @fileoverview UdpAudioManager - Per-session manager for UDP audio handling.
 *
 * Manages UDP audio registration, ping acknowledgments, and cleanup for a user session.
 * Works with the global UdpAudioServer singleton for actual UDP packet handling.
 *
 * Pattern follows other session managers (AudioManager, MicrophoneManager, etc.)
 */

import { Logger } from "pino";

import { UdpRegister, UdpUnregister } from "@mentra/sdk";

import { udpAudioServer } from "../udp/UdpAudioServer";
import { WebSocketReadyState } from "../websocket/types";

import type { UserSession } from "./UserSession";

export class UdpAudioManager {
  private userSession: UserSession;
  private logger: Logger;

  // UDP state
  private _userIdHash?: number;
  private _enabled = false;

  constructor(userSession: UserSession) {
    this.userSession = userSession;
    this.logger = userSession.logger.child({ service: "UdpAudioManager" });
    this.logger.debug("UdpAudioManager initialized");
  }

  /**
   * Whether UDP audio is enabled for this session
   */
  get enabled(): boolean {
    return this._enabled;
  }

  /**
   * The userIdHash for this session (FNV-1a hash of userId)
   */
  get userIdHash(): number | undefined {
    return this._userIdHash;
  }

  /**
   * Handle UDP_REGISTER message from mobile client
   * Registers this session with the global UDP server for packet routing
   */
  handleRegister(message: UdpRegister): void {
    const { userIdHash } = message;

    // Compute expected hash for comparison (FNV-1a of userId)
    const expectedHash = this.computeFnv1aHash(this.userSession.userId);

    this.logger.info(
      {
        userIdHash,
        userIdHashHex: userIdHash.toString(16).padStart(8, "0"),
        userId: this.userSession.userId,
        expectedHash,
        expectedHashHex: expectedHash.toString(16).padStart(8, "0"),
        hashMatch: userIdHash === expectedHash,
        feature: "udp-audio",
      },
      "UDP register request received from mobile",
    );

    if (userIdHash !== expectedHash) {
      this.logger.warn(
        {
          userIdHash,
          userIdHashHex: userIdHash.toString(16).padStart(8, "0"),
          expectedHash,
          expectedHashHex: expectedHash.toString(16).padStart(8, "0"),
          userId: this.userSession.userId,
          userIdBytes: Buffer.from(this.userSession.userId, "utf-8").toString("hex"),
          feature: "udp-audio",
        },
        "UDP userIdHash mismatch! Mobile hash differs from server computed hash",
      );
    }

    // Store state
    this._userIdHash = userIdHash;
    this._enabled = true;

    // Register with the global UDP audio server
    udpAudioServer.registerSession(userIdHash, this.userSession);

    this.logger.info(
      {
        userIdHash,
        userIdHashHex: userIdHash.toString(16).padStart(8, "0"),
        userId: this.userSession.userId,
        udpServerStatus: udpAudioServer.getStats(),
        feature: "udp-audio",
      },
      "UDP audio registered successfully - ready to receive packets",
    );
  }

  /**
   * Compute FNV-1a hash of a string (32-bit, unsigned)
   * Used to verify mobile's hash computation matches server
   */
  private computeFnv1aHash(str: string): number {
    const FNV_PRIME = 0x01000193;
    let hash = 0x811c9dc5;

    const bytes = Buffer.from(str, "utf-8");

    for (let i = 0; i < bytes.length; i++) {
      hash ^= bytes[i];
      hash = Math.imul(hash, FNV_PRIME);
    }

    return hash >>> 0; // Ensure unsigned 32-bit
  }

  /**
   * Handle UDP_UNREGISTER message from mobile client
   * Unregisters this session from UDP audio
   */
  handleUnregister(message: UdpUnregister): void {
    const { userIdHash } = message;
    this.logger.info(
      {
        userIdHash,
        userIdHashHex: userIdHash.toString(16).padStart(8, "0"),
        userId: this.userSession.userId,
        wasEnabled: this._enabled,
        previousHash: this._userIdHash,
        feature: "udp-audio",
      },
      "UDP unregister request received",
    );

    // Unregister from the global UDP audio server
    udpAudioServer.unregisterSession(userIdHash);

    // Clear state
    this._userIdHash = undefined;
    this._enabled = false;

    this.logger.info(
      {
        userIdHash,
        udpServerStatus: udpAudioServer.getStats(),
        feature: "udp-audio",
      },
      "UDP audio unregistered successfully",
    );
  }

  /**
   * Send UDP ping acknowledgment to mobile client via WebSocket
   * Called by UdpAudioServer when it receives a UDP ping packet for this session
   */
  sendPingAck(): void {
    const wsState = this.userSession.websocket?.readyState;

    if (wsState !== WebSocketReadyState.OPEN) {
      this.logger.warn(
        {
          wsState,
          expectedState: WebSocketReadyState.OPEN,
          userId: this.userSession.userId,
          userIdHash: this._userIdHash,
          feature: "udp-audio",
        },
        "Cannot send UDP ping ack - WebSocket not open",
      );
      return;
    }

    try {
      const ackMessage = {
        type: "udp_ping_ack",
        timestamp: Date.now(),
      };
      this.userSession.websocket.send(JSON.stringify(ackMessage));
      this.logger.info(
        {
          userId: this.userSession.userId,
          userIdHash: this._userIdHash,
          userIdHashHex: this._userIdHash?.toString(16).padStart(8, "0"),
          feature: "udp-audio",
        },
        "UDP ping ack sent via WebSocket",
      );
    } catch (error) {
      this.logger.error(
        {
          error,
          userId: this.userSession.userId,
          userIdHash: this._userIdHash,
          feature: "udp-audio",
        },
        "Error sending UDP ping ack",
      );
    }
  }

  /**
   * Dispose of UDP audio manager and cleanup registrations
   */
  dispose(): void {
    if (this._userIdHash !== undefined) {
      this.logger.info(
        { userIdHash: this._userIdHash, feature: "udp-audio" },
        "Disposing UdpAudioManager, unregistering from UDP server",
      );
      udpAudioServer.unregisterBySession(this.userSession);
      this._userIdHash = undefined;
      this._enabled = false;
    }

    this.logger.debug("UdpAudioManager disposed");
  }
}

export default UdpAudioManager;
