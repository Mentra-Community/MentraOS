/**
 * @fileoverview UDP Packet Reorder Buffer
 *
 * Handles out-of-order UDP packets by buffering and emitting in sequence order.
 * Audio packets may arrive out of order due to network routing; this buffer
 * reorders them before forwarding to AudioManager.
 *
 * Design:
 * - Small buffer (10 packets max) to limit memory and latency
 * - Short timeout (20ms) - don't delay more than one audio chunk
 * - Sequence wraps at 65535 (16-bit)
 * - Large gaps (>50) assume packet loss, reset and continue
 */

import { Logger } from "pino";

interface BufferedPacket {
  sequence: number;
  data: Buffer;
  receivedAt: number;
}

const DEFAULT_BUFFER_SIZE = 10;
const DEFAULT_TIMEOUT_MS = 20;
const DEFAULT_MAX_GAP = 50;
const SEQUENCE_MAX = 65535;

export class UdpReorderBuffer {
  private buffer: Map<number, BufferedPacket> = new Map();
  private expectedSeq: number = -1; // -1 means not initialized
  private maxBufferSize: number;
  private timeoutMs: number;
  private maxGap: number;
  private logger: Logger;

  // Stats
  private packetsInOrder = 0;
  private packetsReordered = 0;
  private packetsDropped = 0;

  constructor(
    logger: Logger,
    options?: {
      maxBufferSize?: number;
      timeoutMs?: number;
      maxGap?: number;
    },
  ) {
    this.logger = logger.child({ component: "UdpReorderBuffer" });
    this.maxBufferSize = options?.maxBufferSize ?? DEFAULT_BUFFER_SIZE;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxGap = options?.maxGap ?? DEFAULT_MAX_GAP;
  }

  /**
   * Add a packet to the buffer and return any packets ready to be processed (in order)
   */
  addPacket(sequence: number, data: Buffer): Buffer[] {
    const now = Date.now();
    const result: Buffer[] = [];

    // First packet - initialize expected sequence
    if (this.expectedSeq === -1) {
      this.expectedSeq = sequence;
      this.logger.debug({ sequence, feature: "udp-audio" }, "Initialized expected sequence");
    }

    // Check for large gap (packet loss or reset)
    const gap = this.sequenceDistance(sequence, this.expectedSeq);
    if (gap > this.maxGap) {
      this.logger.warn(
        {
          sequence,
          expectedSeq: this.expectedSeq,
          gap,
          maxGap: this.maxGap,
          bufferedCount: this.buffer.size,
          feature: "udp-audio",
        },
        "Large sequence gap detected - resetting buffer",
      );
      this.reset();
      this.expectedSeq = sequence;
    }

    // Is this the expected packet?
    if (sequence === this.expectedSeq) {
      // Process immediately
      result.push(data);
      this.packetsInOrder++;
      this.expectedSeq = this.nextSequence(this.expectedSeq);

      // Check buffer for consecutive packets
      const consecutive = this.flushConsecutive();
      result.push(...consecutive);
    } else if (this.isAhead(sequence, this.expectedSeq)) {
      // Packet arrived early - buffer it
      if (this.buffer.size >= this.maxBufferSize) {
        // Buffer full - drop oldest or flush
        this.logger.debug(
          { bufferSize: this.buffer.size, sequence, feature: "udp-audio" },
          "Buffer full, flushing oldest",
        );
        const flushed = this.flushOldest();
        result.push(...flushed);
      }

      this.buffer.set(sequence, { sequence, data, receivedAt: now });
    } else {
      // Packet is behind expected - already processed or very late
      this.packetsDropped++;
      this.logger.debug({ sequence, expectedSeq: this.expectedSeq, feature: "udp-audio" }, "Dropping late packet");
    }

    // Flush any timed-out packets
    const timedOut = this.flushTimedOut(now);
    result.push(...timedOut);

    return result;
  }

  /**
   * Flush all consecutive packets from buffer starting at expectedSeq
   */
  private flushConsecutive(): Buffer[] {
    const result: Buffer[] = [];

    while (this.buffer.has(this.expectedSeq)) {
      const packet = this.buffer.get(this.expectedSeq)!;
      this.buffer.delete(this.expectedSeq);
      result.push(packet.data);
      this.packetsReordered++;
      this.expectedSeq = this.nextSequence(this.expectedSeq);
    }

    return result;
  }

  /**
   * Flush oldest packet(s) when buffer is full
   */
  private flushOldest(): Buffer[] {
    const result: Buffer[] = [];

    // Find the oldest packet
    let oldest: BufferedPacket | null = null;
    for (const packet of this.buffer.values()) {
      if (!oldest || packet.receivedAt < oldest.receivedAt) {
        oldest = packet;
      }
    }

    if (oldest) {
      // Skip to this sequence and flush
      this.expectedSeq = oldest.sequence;
      result.push(...this.flushConsecutive());
    }

    return result;
  }

  /**
   * Flush packets that have been waiting too long
   */
  private flushTimedOut(now: number): Buffer[] {
    const result: Buffer[] = [];
    const expiredBefore = now - this.timeoutMs;

    // Find timed-out packets
    const timedOut: BufferedPacket[] = [];
    for (const packet of this.buffer.values()) {
      if (packet.receivedAt < expiredBefore) {
        timedOut.push(packet);
      }
    }

    if (timedOut.length > 0) {
      // Sort by sequence and process
      timedOut.sort((a, b) => this.sequenceCompare(a.sequence, b.sequence));

      for (const packet of timedOut) {
        this.buffer.delete(packet.sequence);
        result.push(packet.data);
        this.packetsReordered++;

        // Update expected sequence if needed
        if (this.isAhead(this.nextSequence(packet.sequence), this.expectedSeq)) {
          this.expectedSeq = this.nextSequence(packet.sequence);
        }
      }

      this.logger.debug({ flushedCount: timedOut.length, feature: "udp-audio" }, "Flushed timed-out packets");
    }

    return result;
  }

  /**
   * Force flush all buffered packets (e.g., on session end)
   */
  flush(): Buffer[] {
    const packets = Array.from(this.buffer.values());
    packets.sort((a, b) => this.sequenceCompare(a.sequence, b.sequence));

    const result = packets.map((p) => p.data);
    this.buffer.clear();

    return result;
  }

  /**
   * Reset the buffer state
   */
  reset(): void {
    this.buffer.clear();
    this.expectedSeq = -1;
  }

  /**
   * Get next sequence number (handles wraparound)
   */
  private nextSequence(seq: number): number {
    return (seq + 1) & SEQUENCE_MAX;
  }

  /**
   * Calculate distance from seq1 to seq2 (handling wraparound)
   */
  private sequenceDistance(seq1: number, seq2: number): number {
    const diff = seq1 - seq2;
    if (diff >= 0 && diff <= SEQUENCE_MAX / 2) {
      return diff;
    } else if (diff < 0 && diff >= -(SEQUENCE_MAX / 2)) {
      return -diff;
    } else if (diff > SEQUENCE_MAX / 2) {
      return SEQUENCE_MAX + 1 - diff;
    } else {
      return SEQUENCE_MAX + 1 + diff;
    }
  }

  /**
   * Check if seq1 is ahead of seq2 (handling wraparound)
   */
  private isAhead(seq1: number, seq2: number): boolean {
    const diff = (seq1 - seq2) & SEQUENCE_MAX;
    return diff > 0 && diff < SEQUENCE_MAX / 2;
  }

  /**
   * Compare two sequences for sorting (handling wraparound)
   */
  private sequenceCompare(seq1: number, seq2: number): number {
    const diff = (seq1 - seq2) & SEQUENCE_MAX;
    if (diff === 0) return 0;
    if (diff < SEQUENCE_MAX / 2) return 1;
    return -1;
  }

  /**
   * Get buffer statistics
   */
  getStats(): {
    inOrder: number;
    reordered: number;
    dropped: number;
    buffered: number;
  } {
    return {
      inOrder: this.packetsInOrder,
      reordered: this.packetsReordered,
      dropped: this.packetsDropped,
      buffered: this.buffer.size,
    };
  }
}

export default UdpReorderBuffer;
