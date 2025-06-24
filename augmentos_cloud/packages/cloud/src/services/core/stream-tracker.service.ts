// augmentos_cloud/packages/cloud/src/services/core/stream-tracker.service.ts

/**
 * @fileoverview Stream Tracker Service for managing RTMP stream state and keep-alive functionality.
 * This service tracks active streams, manages keep-alive timers, and handles stream cleanup.
 */

import { logger } from '@mentra/utils';
import crypto from 'crypto';

interface StreamInfo {
  streamId: string;
  sessionId: string;
  appId: string;
  rtmpUrl: string;
  status: 'initializing' | 'active' | 'stopping' | 'stopped' | 'timeout';
  startTime: Date;
  lastKeepAlive: Date;
  keepAliveTimer?: NodeJS.Timeout;
  pendingAcks: Map<string, { sentAt: Date; timeout: NodeJS.Timeout; }>;
  missedAcks: number;
}

export class StreamTrackerService {
  private streams: Map<string, StreamInfo> = new Map();
  private static readonly KEEP_ALIVE_INTERVAL_MS = 15000; // 15 seconds keep-alive interval
  private static readonly STREAM_TIMEOUT_MS = 60000; // 60 seconds timeout (should match glasses timeout)
  private static readonly ACK_TIMEOUT_MS = 5000; // 5 seconds to wait for ACK
  private static readonly MAX_MISSED_ACKS = 3; // Max consecutive missed ACKs before considering connection suspect

  /**
   * Start tracking a new stream
   */
  public startTracking(streamId: string, sessionId: string, appId: string, rtmpUrl: string): void {
    logger.info(`[StreamTracker]: Starting tracking for streamId: ${streamId}, app: ${appId}`);

    // Cancel existing stream if any
    this.stopTracking(streamId);

    const now = new Date();
    const streamInfo: StreamInfo = {
      streamId,
      sessionId,
      appId,
      rtmpUrl,
      status: 'initializing',
      startTime: now,
      lastKeepAlive: now,
      pendingAcks: new Map(),
      missedAcks: 0
    };

    this.streams.set(streamId, streamInfo);
    this.scheduleKeepAlive(streamId);
  }

  /**
   * Update stream status
   */
  public updateStatus(streamId: string, status: StreamInfo['status']): void {
    const stream = this.streams.get(streamId);
    if (stream) {
      logger.info(`[StreamTracker]: Updating stream ${streamId} status: ${stream.status} -> ${status}`);
      stream.status = status;
      stream.lastKeepAlive = new Date();

      // If stream is stopped or timed out, stop tracking
      if (status === 'stopped' || status === 'timeout') {
        this.stopTracking(streamId);
      }
    } else {
      logger.warn(`[StreamTracker]: Attempted to update status for unknown stream: ${streamId}`);
    }
  }

  /**
   * Stop tracking a stream and clean up resources
   */
  public stopTracking(streamId: string): void {
    const stream = this.streams.get(streamId);
    if (stream) {
      logger.info(`[StreamTracker]: Stopping tracking for streamId: ${streamId}`);

      // Cancel keep-alive timer
      if (stream.keepAliveTimer) {
        clearInterval(stream.keepAliveTimer);
      }

      // Cancel all pending ACK timeouts
      for (const [ackId, ackInfo] of stream.pendingAcks) {
        clearTimeout(ackInfo.timeout);
      }
      stream.pendingAcks.clear();

      this.streams.delete(streamId);
    }
  }

  /**
   * Get stream information
   */
  public getStream(streamId: string): StreamInfo | undefined {
    return this.streams.get(streamId);
  }

  /**
   * Get all active streams for a session
   */
  public getStreamsForSession(sessionId: string): StreamInfo[] {
    return Array.from(this.streams.values()).filter(stream => stream.sessionId === sessionId);
  }

  /**
   * Get all active streams for an app
   */
  public getStreamsForApp(appId: string): StreamInfo[] {
    return Array.from(this.streams.values()).filter(stream => stream.appId === appId);
  }

  /**
   * Check if a stream is active
   */
  public isStreamActive(streamId: string): boolean {
    const stream = this.streams.get(streamId);
    return stream ? ['initializing', 'active'].includes(stream.status) : false;
  }

  /**
   * Get all active streams
   */
  public getAllActiveStreams(): StreamInfo[] {
    return Array.from(this.streams.values()).filter(stream =>
      ['initializing', 'active'].includes(stream.status)
    );
  }

  /**
   * Schedule keep-alive message for a stream
   */
  private scheduleKeepAlive(streamId: string): void {
    const stream = this.streams.get(streamId);
    if (!stream) {
      logger.warn(`[StreamTracker]: Cannot schedule keep-alive for unknown stream: ${streamId}`);
      return;
    }

    // Cancel existing timer
    if (stream.keepAliveTimer) {
      clearInterval(stream.keepAliveTimer);
    }

    // Schedule periodic keep-alive
    stream.keepAliveTimer = setInterval(() => {
      this.sendKeepAlive(streamId);
    }, StreamTrackerService.KEEP_ALIVE_INTERVAL_MS);

    logger.debug(`[StreamTracker]: Scheduled keep-alive for stream ${streamId} every ${StreamTrackerService.KEEP_ALIVE_INTERVAL_MS}ms`);
  }

  /**
   * Send keep-alive message to glasses for a specific stream
   */
  private sendKeepAlive(streamId: string): void {
    const stream = this.streams.get(streamId);
    if (!stream) {
      logger.warn(`[StreamTracker]: Cannot send keep-alive for unknown stream: ${streamId}`);
      return;
    }

    // Check if stream is still active
    if (!['initializing', 'active'].includes(stream.status)) {
      logger.debug(`[StreamTracker]: Skipping keep-alive for inactive stream ${streamId} (status: ${stream.status})`);
      this.stopTracking(streamId);
      return;
    }

    // Check if stream has timed out (no activity for too long)
    const timeSinceLastActivity = Date.now() - stream.lastKeepAlive.getTime();
    if (timeSinceLastActivity > StreamTrackerService.STREAM_TIMEOUT_MS) {
      logger.warn(`[StreamTracker]: Stream ${streamId} has timed out (${timeSinceLastActivity}ms since last activity)`);
      this.updateStatus(streamId, 'timeout');
      return;
    }

    // Generate ACK ID and track it
    const ackId = crypto.randomUUID();
    this.trackKeepAliveAck(streamId, ackId);

    // Send keep-alive message via websocket service
    // This will be called by the websocket service after we integrate it
    this.onKeepAliveSent?.(streamId, ackId);

    logger.debug(`[StreamTracker]: Sent keep-alive for stream ${streamId} with ACK ${ackId}`);
  }

  /**
   * Track a sent keep-alive ACK
   * @param streamId The stream ID
   * @param ackId The ACK ID to track
   */
  public trackKeepAliveAck(streamId: string, ackId: string): void {
    const stream = this.streams.get(streamId);
    if (!stream) {
      logger.warn(`[StreamTracker]: Cannot track ACK for unknown stream: ${streamId}`);
      return;
    }

    const ackTimeout = setTimeout(() => {
      this.handleMissedAck(streamId, ackId);
    }, StreamTrackerService.ACK_TIMEOUT_MS);

    stream.pendingAcks.set(ackId, {
      sentAt: new Date(),
      timeout: ackTimeout
    });

    logger.debug(`[StreamTracker]: Tracking ACK ${ackId} for stream ${streamId}`);
  }

  /**
   * Process a received ACK
   * @param streamId The stream ID
   * @param ackId The ACK ID received
   */
  public processKeepAliveAck(streamId: string, ackId: string): void {
    const stream = this.streams.get(streamId);
    if (!stream) {
      logger.warn(`[StreamTracker]: Received ACK for unknown stream: ${streamId}`);
      return;
    }

    const ackInfo = stream.pendingAcks.get(ackId);
    if (!ackInfo) {
      logger.warn(`[StreamTracker]: Received unknown ACK ${ackId} for stream ${streamId}`);
      return;
    }

    // Clear the timeout and remove from pending
    clearTimeout(ackInfo.timeout);
    stream.pendingAcks.delete(ackId);

    // Reset missed ACK counter on successful ACK
    stream.missedAcks = 0;
    stream.lastKeepAlive = new Date();

    logger.debug(`[StreamTracker]: Processed ACK ${ackId} for stream ${streamId}`);
  }

  /**
   * Handle a missed ACK (timeout)
   * @param streamId The stream ID
   * @param ackId The ACK ID that timed out
   */
  private handleMissedAck(streamId: string, ackId: string): void {
    const stream = this.streams.get(streamId);
    if (!stream) {
      return;
    }

    // Remove from pending ACKs
    stream.pendingAcks.delete(ackId);
    stream.missedAcks++;

    logger.warn(`[StreamTracker]: Missed ACK ${ackId} for stream ${streamId} (${stream.missedAcks}/${StreamTrackerService.MAX_MISSED_ACKS})`);

    // If too many missed ACKs, consider connection suspect
    if (stream.missedAcks >= StreamTrackerService.MAX_MISSED_ACKS) {
      logger.error(`[StreamTracker]: Too many missed ACKs for stream ${streamId}, marking as timeout`);
      this.updateStatus(streamId, 'timeout');
    }
  }

  /**
   * Check if stream has connection issues (missed ACKs)
   * @param streamId The stream ID
   * @returns true if connection seems suspect
   */
  public hasConnectionIssues(streamId: string): boolean {
    const stream = this.streams.get(streamId);
    return stream ? stream.missedAcks > 0 : false;
  }

  /**
   * Callback when keep-alive is sent (to be set by websocket service)
   */
  public onKeepAliveSent?: (streamId: string, ackId: string) => void;

  /**
   * Clean up all streams for a session (called when session ends)
   */
  public cleanupSession(sessionId: string): void {
    logger.info(`[StreamTracker]: Cleaning up all streams for session: ${sessionId}`);

    const streamsToCleanup = this.getStreamsForSession(sessionId);
    for (const stream of streamsToCleanup) {
      this.stopTracking(stream.streamId);
    }
  }

  /**
   * Get statistics about tracked streams
   */
  public getStats(): {
    totalStreams: number;
    activeStreams: number;
    streamsByStatus: Record<string, number>;
  } {
    const allStreams = Array.from(this.streams.values());
    const activeStreams = allStreams.filter(s => ['initializing', 'active'].includes(s.status));

    const streamsByStatus: Record<string, number> = {};
    for (const stream of allStreams) {
      streamsByStatus[stream.status] = (streamsByStatus[stream.status] || 0) + 1;
    }

    return {
      totalStreams: allStreams.length,
      activeStreams: activeStreams.length,
      streamsByStatus
    };
  }
}

// Export singleton instance
export const streamTrackerService = new StreamTrackerService();
export default streamTrackerService;