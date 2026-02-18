/**
 * @fileoverview UDP Audio Server for receiving audio packets directly from mobile clients.
 *
 * This replaces the Go bridge UDP listener with a Bun-native implementation.
 * Mobile clients send audio over UDP for lowest latency.
 *
 * Unencrypted packet format:
 * - Bytes 0-3: userIdHash (FNV-1a 32-bit, big-endian)
 * - Bytes 4-5: sequence number (big-endian)
 * - Bytes 6+: audio data (PCM or LC3 depending on client config, or "PING" for ping packets)
 *
 * Encrypted packet format (when client connects with ?udpEncryption=true):
 * - Bytes 0-3: userIdHash (FNV-1a 32-bit, big-endian)
 * - Bytes 4-5: sequence number (big-endian)
 * - Bytes 6-29: nonce (24 bytes for XSalsa20)
 * - Bytes 30+: ciphertext (encrypted audio + 16-byte Poly1305 auth tag)
 *
 * Audio format is determined by the client's audio configuration sent via REST endpoint.
 * AudioManager handles decoding LC3 to PCM if needed.
 */

import { logger as rootLogger } from "../logging/pino-logger";
import type { UserSession } from "../session/UserSession";

import { NONCE_SIZE, TAG_SIZE } from "./UdpCrypto";
import { UdpReorderBuffer } from "./UdpReorderBuffer";

const UDP_PORT = 8000;
const PING_MAGIC = "PING";
const MIN_PACKET_SIZE = 6; // 4 bytes hash + 2 bytes sequence
const MIN_ENCRYPTED_PACKET_SIZE = 6 + NONCE_SIZE + TAG_SIZE; // header + nonce + minimum ciphertext (just tag)
const LOG_INTERVAL = 100; // Log every N packets for debugging

export class UdpAudioServer {
  private socket: any = null;
  private sessionMap: Map<number, UserSession> = new Map(); // userIdHash → session
  private reorderBuffers: Map<number, UdpReorderBuffer> = new Map(); // userIdHash → reorder buffer
  private logger = rootLogger.child({ service: "UdpAudioServer" });

  // Stats
  private packetsReceived = 0;
  private packetsDropped = 0;
  private pingsReceived = 0;
  private packetsDecrypted = 0;
  private decryptionFailures = 0;

  /**
   * Start the UDP server on port 8000
   */
  async start(): Promise<void> {
    try {
      this.socket = await Bun.udpSocket({
        port: UDP_PORT,
        socket: {
          data: (_socket: unknown, buf: Buffer, port: number, addr: string) => {
            this.handlePacket(buf, port, addr);
          },
        },
      });

      this.logger.info({ port: UDP_PORT, feature: "udp-audio" }, "UDP Audio Server started");
    } catch (error) {
      this.logger.error({ error, port: UDP_PORT, feature: "udp-audio" }, "Failed to start UDP Audio Server");
      throw error;
    }
  }

  /**
   * Handle incoming UDP packet
   */
  private handlePacket(buf: Buffer, port: number, addr: string): void {
    const totalPackets = this.packetsReceived + this.packetsDropped + this.pingsReceived;

    // Log first few packets for debugging
    if (totalPackets < 5) {
      this.logger.info(
        {
          bufferLength: buf.length,
          addr,
          port,
          hexHead: buf.slice(0, Math.min(16, buf.length)).toString("hex"),
          feature: "udp-audio",
        },
        "UDP packet received (first 5 packets)",
      );
    }

    // Minimum packet size check
    if (buf.length < MIN_PACKET_SIZE) {
      this.packetsDropped++;
      this.logger.warn(
        {
          bufferLength: buf.length,
          minRequired: MIN_PACKET_SIZE,
          addr,
          port,
          feature: "udp-audio",
        },
        "UDP packet too small, dropping",
      );
      return;
    }

    // Parse header (big-endian)
    const userIdHash = buf.readUInt32BE(0);
    const sequence = buf.readUInt16BE(4);

    // Check for ping packet: "PING" at bytes 6-9
    if (buf.length >= 10 && buf.slice(6, 10).toString() === PING_MAGIC) {
      this.handlePing(userIdHash, addr, port);
      return;
    }

    // Lookup session by userIdHash
    const session = this.sessionMap.get(userIdHash);
    if (!session) {
      this.packetsDropped++;
      // Log unregistered userIdHash (but not too often)
      if (this.packetsDropped <= 5 || this.packetsDropped % 100 === 0) {
        this.logger.warn(
          {
            userIdHash,
            userIdHashHex: userIdHash.toString(16).padStart(8, "0"),
            sequence,
            addr,
            port,
            registeredHashes: Array.from(this.sessionMap.keys()).map((h) => h.toString(16).padStart(8, "0")),
            packetsDropped: this.packetsDropped,
            feature: "udp-audio",
          },
          "UDP packet from unregistered userIdHash",
        );
      }
      return;
    }

    // Extract audio data (after 6-byte header)
    // May be encrypted if session has encryption enabled
    let audioData: Buffer | Uint8Array = buf.slice(6);

    // Handle encryption if enabled for this session
    if (session.udpAudioManager.encryptionEnabled) {
      // Encrypted packet: [nonce(24)|ciphertext(audio + 16 bytes tag)]
      if (buf.length < MIN_ENCRYPTED_PACKET_SIZE) {
        this.packetsDropped++;
        this.logger.warn(
          {
            userIdHash,
            sequence,
            bufferLength: buf.length,
            minRequired: MIN_ENCRYPTED_PACKET_SIZE,
            feature: "udp-audio-encryption",
          },
          "Encrypted UDP packet too small",
        );
        return;
      }

      const decrypted = session.udpAudioManager.decryptAudio(new Uint8Array(audioData));
      if (!decrypted) {
        this.decryptionFailures++;
        this.packetsDropped++;
        if (this.decryptionFailures <= 5 || this.decryptionFailures % 100 === 0) {
          this.logger.warn(
            {
              userIdHash,
              sequence,
              encryptedLength: audioData.length,
              decryptionFailures: this.decryptionFailures,
              feature: "udp-audio-encryption",
            },
            "UDP packet decryption failed",
          );
        }
        return;
      }

      audioData = decrypted;
      this.packetsDecrypted++;

      // Log first decrypted packet
      if (this.packetsDecrypted === 1) {
        this.logger.info(
          {
            userIdHash,
            sequence,
            encryptedLength: buf.length - 6,
            decryptedLength: audioData.length,
            feature: "udp-audio-encryption",
          },
          "First encrypted UDP packet decrypted successfully",
        );
      }
    }

    // Validate audio data exists
    if (audioData.length === 0) {
      this.packetsDropped++;
      this.logger.warn(
        {
          userIdHash,
          sequence,
          bufferLength: buf.length,
          feature: "udp-audio",
        },
        "UDP packet has no audio data after header",
      );
      return;
    }

    this.packetsReceived++;

    // Log first audio packet and then periodically
    if (this.packetsReceived === 1) {
      this.logger.info(
        {
          userId: session.userId,
          userIdHash,
          sequence,
          audioBytes: audioData.length,
          addr,
          port,
          feature: "udp-audio",
        },
        "First UDP audio packet received and forwarding to AudioManager",
      );
    } else if (this.packetsReceived % LOG_INTERVAL === 0) {
      this.logger.info(
        {
          packetsReceived: this.packetsReceived,
          packetsDropped: this.packetsDropped,
          pingsReceived: this.pingsReceived,
          packetsDecrypted: this.packetsDecrypted,
          decryptionFailures: this.decryptionFailures,
          activeSessions: this.sessionMap.size,
          lastSequence: sequence,
          lastAudioBytes: audioData.length,
          feature: "udp-audio",
        },
        "UDP audio stats",
      );
    }

    // Get or create reorder buffer for this session
    let reorderBuffer = this.reorderBuffers.get(userIdHash);
    if (!reorderBuffer) {
      reorderBuffer = new UdpReorderBuffer(this.logger);
      this.reorderBuffers.set(userIdHash, reorderBuffer);
    }

    // Add packet to reorder buffer and process any ready packets
    // Convert Uint8Array to Buffer if needed (decrypted data is Uint8Array)
    const audioBuffer = Buffer.isBuffer(audioData) ? audioData : Buffer.from(audioData);
    const packetsToProcess = reorderBuffer.addPacket(sequence, audioBuffer);

    // Forward reordered packets to AudioManager
    // AudioManager handles LC3→PCM decoding if needed based on client's audio config
    try {
      for (const audioChunk of packetsToProcess) {
        session.audioManager.processAudioData(audioChunk, "udp");
      }
    } catch (error) {
      this.logger.error(
        {
          error,
          userId: session.userId,
          userIdHash,
          sequence,
          audioBytes: audioData.length,
          feature: "udp-audio",
        },
        "Error processing UDP audio in AudioManager",
      );
    }
  }

  /**
   * Handle UDP ping packet - send ack via WebSocket
   */
  private handlePing(userIdHash: number, addr: string, port: number): void {
    this.pingsReceived++;

    const session = this.sessionMap.get(userIdHash);
    if (!session) {
      this.logger.warn(
        {
          userIdHash,
          userIdHashHex: userIdHash.toString(16).padStart(8, "0"),
          addr,
          port,
          registeredHashes: Array.from(this.sessionMap.keys()).map((h) => h.toString(16).padStart(8, "0")),
          pingsReceived: this.pingsReceived,
          feature: "udp-audio",
        },
        "UDP ping from unregistered userIdHash - session not found",
      );
      return;
    }

    this.logger.info(
      {
        userId: session.userId,
        userIdHash,
        userIdHashHex: userIdHash.toString(16).padStart(8, "0"),
        addr,
        port,
        pingsReceived: this.pingsReceived,
        feature: "udp-audio",
      },
      "UDP ping received, sending ack via WebSocket",
    );

    // Send ack via WebSocket through the UDP audio manager
    try {
      session.udpAudioManager.sendPingAck();
      this.logger.debug(
        {
          userId: session.userId,
          userIdHash,
          feature: "udp-audio",
        },
        "UDP ping ack sent successfully",
      );
    } catch (error) {
      this.logger.error(
        {
          error,
          userId: session.userId,
          userIdHash,
          feature: "udp-audio",
        },
        "Failed to send UDP ping ack",
      );
    }
  }

  /**
   * Register a session for UDP audio reception
   * Called when mobile sends UDP_REGISTER message
   */
  registerSession(userIdHash: number, session: UserSession): void {
    // Check for existing registration with same hash (collision detection)
    const existing = this.sessionMap.get(userIdHash);
    if (existing && existing !== session) {
      this.logger.warn(
        {
          userIdHash,
          userIdHashHex: userIdHash.toString(16).padStart(8, "0"),
          existingUserId: existing.userId,
          newUserId: session.userId,
          feature: "udp-audio",
        },
        "userIdHash collision detected - overwriting existing registration",
      );
    }

    this.sessionMap.set(userIdHash, session);

    // Create reorder buffer for this session
    this.reorderBuffers.set(userIdHash, new UdpReorderBuffer(this.logger));

    this.logger.info(
      {
        userId: session.userId,
        userIdHash,
        userIdHashHex: userIdHash.toString(16).padStart(8, "0"),
        activeSessions: this.sessionMap.size,
        allRegisteredHashes: Array.from(this.sessionMap.keys()).map((h) => ({
          hash: h,
          hex: h.toString(16).padStart(8, "0"),
          userId: this.sessionMap.get(h)?.userId,
        })),
        feature: "udp-audio",
      },
      "Session registered for UDP audio - ready to receive packets",
    );
  }

  /**
   * Unregister a session from UDP audio reception
   * Called when mobile sends UDP_UNREGISTER message
   */
  unregisterSession(userIdHash: number): void {
    const session = this.sessionMap.get(userIdHash);
    const reorderBuffer = this.reorderBuffers.get(userIdHash);

    if (session) {
      // Flush any remaining buffered packets
      if (reorderBuffer) {
        const remaining = reorderBuffer.flush();
        if (remaining.length > 0) {
          this.logger.info(
            { userIdHash, flushedPackets: remaining.length, feature: "udp-audio" },
            "Flushed remaining packets on unregister",
          );
          for (const audioChunk of remaining) {
            try {
              session.audioManager.processAudioData(audioChunk, "udp");
            } catch {
              // Ignore errors during cleanup
            }
          }
        }
      }

      const stats = reorderBuffer?.getStats();
      this.logger.info(
        {
          userId: session.userId,
          userIdHash,
          reorderStats: stats,
          feature: "udp-audio",
        },
        "Session unregistered from UDP audio",
      );
    }

    this.sessionMap.delete(userIdHash);
    this.reorderBuffers.delete(userIdHash);
  }

  /**
   * Unregister a session by reference (for cleanup during session disposal)
   * This is useful when we don't have the userIdHash handy
   */
  unregisterBySession(session: UserSession): void {
    for (const [hash, s] of this.sessionMap) {
      if (s === session) {
        // Flush remaining packets before cleanup
        const reorderBuffer = this.reorderBuffers.get(hash);
        if (reorderBuffer) {
          const remaining = reorderBuffer.flush();
          if (remaining.length > 0) {
            for (const audioChunk of remaining) {
              try {
                session.audioManager.processAudioData(audioChunk, "udp");
              } catch {
                // Ignore errors during cleanup
              }
            }
          }
        }

        const stats = reorderBuffer?.getStats();
        this.sessionMap.delete(hash);
        this.reorderBuffers.delete(hash);
        this.logger.info(
          {
            userId: session.userId,
            userIdHash: hash,
            reorderStats: stats,
            feature: "udp-audio",
          },
          "Session unregistered from UDP audio (by reference)",
        );
        return;
      }
    }
  }

  /**
   * Check if the UDP server is running
   */
  isRunning(): boolean {
    return this.socket !== null;
  }

  /**
   * Get current statistics
   */
  getStats(): {
    received: number;
    dropped: number;
    pings: number;
    sessions: number;
    decrypted: number;
    decryptionFailures: number;
  } {
    return {
      received: this.packetsReceived,
      dropped: this.packetsDropped,
      pings: this.pingsReceived,
      sessions: this.sessionMap.size,
      decrypted: this.packetsDecrypted,
      decryptionFailures: this.decryptionFailures,
    };
  }

  /**
   * Get full status for health checks
   */
  getStatus(): {
    running: boolean;
    port: number;
    stats: {
      received: number;
      dropped: number;
      pings: number;
      sessions: number;
    };
  } {
    return {
      running: this.isRunning(),
      port: UDP_PORT,
      stats: this.getStats(),
    };
  }

  /**
   * Check if a userIdHash is registered
   */
  isRegistered(userIdHash: number): boolean {
    return this.sessionMap.has(userIdHash);
  }

  /**
   * Stop the UDP server and cleanup
   */
  async stop(): Promise<void> {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    const sessionCount = this.sessionMap.size;
    this.sessionMap.clear();
    this.reorderBuffers.clear();

    this.logger.info(
      {
        packetsReceived: this.packetsReceived,
        packetsDropped: this.packetsDropped,
        pingsReceived: this.pingsReceived,
        clearedSessions: sessionCount,
        feature: "udp-audio",
      },
      "UDP Audio Server stopped",
    );
  }
}

// Singleton instance
export const udpAudioServer = new UdpAudioServer();
