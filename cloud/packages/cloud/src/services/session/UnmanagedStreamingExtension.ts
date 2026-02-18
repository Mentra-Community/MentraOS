/**
 * @fileoverview UnmanagedStreamingExtension manages direct RTMP streaming within a user session.
 * Simplified from complex multi-timeout system to proven stream-tracker.service.ts patterns.
 */

import { Logger } from "pino";

import {
  CloudToGlassesMessageType,
  CloudToAppMessageType,
  AppToCloudMessageType,
  RtmpStreamStatus,
  KeepAliveAck,
  StartRtmpStream,
  StopRtmpStream,
  KeepRtmpStreamAlive,
  VideoConfig,
  AudioConfig,
  StreamConfig,
  RtmpStreamRequest,
  RtmpStreamStopRequest,
  GlassesToCloudMessageType,
} from "@mentra/sdk";


import { StreamLifecycleController } from "../streaming/StreamLifecycleController";
import { ConnectionValidator } from "../validators/ConnectionValidator";
import { WebSocketReadyState } from "../websocket/types";

import UserSession from "./UserSession";
// session.service no longer needed; using UserSession instance methods

// Constants from the original stream-tracker.service.ts
const KEEP_ALIVE_INTERVAL_MS = 15000; // 15 seconds keep-alive interval
const ACK_TIMEOUT_MS = 10000; // 10 seconds to wait for ACK
const MAX_MISSED_ACKS = 3; // Max consecutive missed ACKs before considering connection suspect

type UnmanagedStreamStatus =
  | "initializing"
  | "active"
  | "stopping"
  | "stopped"
  | "timeout";

interface UnmanagedStreamRuntime {
  streamId: string;
  packageName: string;
  rtmpUrl: string;
  status: UnmanagedStreamStatus;
  startTime: Date;
  lastActivity: Date;
  options: {
    video?: VideoConfig;
    audio?: AudioConfig;
    stream?: StreamConfig;
  };
  lifecycle: StreamLifecycleController;
}

export class UnmanagedStreamingExtension {
  private userSession: UserSession;
  private logger: Logger;
  private unmanagedStreams: Map<string, UnmanagedStreamRuntime> = new Map();

  constructor(userSession: UserSession) {
    this.userSession = userSession;
    this.logger = userSession.logger.child({
      service: "UnmanagedStreamingExtension",
    });
    this.logger.info("UnmanagedStreamingExtension initialized");
  }

  /**
   * Start tracking a new RTMP stream (simplified from original stream-tracker logic)
   */
  async startRtmpStream(request: RtmpStreamRequest): Promise<string> {
    const {
      packageName,
      rtmpUrl,
      video,
      audio,
      stream: streamOptions,
    } = request;
    this.logger.info(
      {
        debugKey: "RTMP_STREAM_START_REQUEST",
        packageName,
        rtmpUrl,
        hasVideo: !!video,
        hasAudio: !!audio,
        hasStreamOptions: !!streamOptions,
        currentActiveStreams: this.unmanagedStreams.size,
        sessionId: this.userSession.sessionId,
        userId: this.userSession.userId,
      },
      "RTMP_STREAM_START_REQUEST: UnmanagedStreamingExtension starting RTMP stream tracking request",
    );

    // Basic validation
    if (!this.userSession.appManager.isAppRunning(packageName)) {
      throw new Error(`App ${packageName} is not running`);
    }
    const validation = ConnectionValidator.validateForHardwareRequest(
      this.userSession,
      "stream",
    );
    if (!validation.valid) {
      const connectionStatus = ConnectionValidator.getConnectionStatus(
        this.userSession,
      );
      this.logger.error(
        {
          userId: this.userSession.userId,
          packageName,
          error: validation.error,
          errorCode: validation.errorCode,
          connectionStatus,
        },
        "RTMP stream request blocked by connection validator",
      );
      const error = new Error(
        validation.error ||
          "Cannot process stream request - connection validation failed",
      );
      (error as any).code = validation.errorCode;
      throw error;
    }

    // WiFi validation for glasses that require it
    const wifiValidation = ConnectionValidator.validateWifiForOperation(
      this.userSession,
    );
    if (!wifiValidation.valid) {
      this.logger.error(
        {
          userId: this.userSession.userId,
          packageName,
          error: wifiValidation.error,
          errorCode: wifiValidation.errorCode,
        },
        "RTMP stream request blocked - WiFi required",
      );
      const error = new Error(
        wifiValidation.error || "WiFi connection required for streaming",
      );
      (error as any).code = wifiValidation.errorCode;
      throw error;
    }
    if (
      !rtmpUrl ||
      (!rtmpUrl.startsWith("rtmp://") && !rtmpUrl.startsWith("rtmps://"))
    ) {
      throw new Error("Invalid RTMP URL");
    }
    if (
      !this.userSession.websocket ||
      this.userSession.websocket.readyState !== WebSocketReadyState.OPEN
    ) {
      throw new Error("Glasses WebSocket not connected");
    }

    // Check for managed stream conflicts and stop if exists
    if (
      this.userSession.managedStreamingExtension.checkUnmanagedStreamConflict(
        this.userSession.userId,
      )
    ) {
      // Stop the managed stream instead of throwing error
      this.logger.info(
        {
          userId: this.userSession.userId,
          packageName,
          debugKey: "STOPPING_MANAGED_STREAM_FOR_UNMANAGED",
        },
        "STOPPING_MANAGED_STREAM_FOR_UNMANAGED: Stopping existing managed stream to start new unmanaged stream",
      );

      // Get current managed stream viewers for this user and stop them
      const activeViewers =
        this.userSession.managedStreamingExtension.getManagedStreamViewers(
          this.userSession.userId,
        );
      for (const viewerPackageName of activeViewers) {
        await this.userSession.managedStreamingExtension.stopManagedStream(
          this.userSession,
          {
            type: AppToCloudMessageType.MANAGED_STREAM_STOP,
            packageName: viewerPackageName,
          },
        );
      }
    }

    // Shorter streamId for BLE efficiency
    const streamId = this.generateStreamId();

    // Stop ALL existing unmanaged streams for this user (not just for this app)
    this.logger.info(
      {
        userId: this.userSession.userId,
        packageName,
        activeStreams: this.unmanagedStreams.size,
        debugKey: "STOPPING_ALL_UNMANAGED_STREAMS",
      },
      "STOPPING_ALL_UNMANAGED_STREAMS: Stopping all existing unmanaged streams before starting new one",
    );

    // Stop all active streams for this session
    for (const [existingStreamId, runtime] of this.unmanagedStreams) {
      if (["initializing", "active"].includes(runtime.status)) {
        this.logger.debug(
          {
            streamId: existingStreamId,
            packageName: runtime.packageName,
            status: runtime.status,
          },
          "Stopping existing unmanaged stream",
        );
        await this.updateStatus(existingStreamId, "stopped");
      }
    }

    const now = new Date();
    const lifecycle = this.createLifecycleController(streamId, packageName);
    const runtime: UnmanagedStreamRuntime = {
      streamId,
      packageName,
      rtmpUrl,
      status: "initializing",
      startTime: now,
      lastActivity: now,
      options: { video, audio, stream: streamOptions },
      lifecycle,
    };

    this.unmanagedStreams.set(streamId, runtime);

    this.userSession.streamRegistry.createUnmanagedStream({
      userId: this.userSession.userId,
      appId: packageName,
      rtmpUrl,
      streamId,
      video,
      audio,
      stream: streamOptions,
    });

    // Send start command to glasses
    const startMessage: StartRtmpStream = {
      type: CloudToGlassesMessageType.START_RTMP_STREAM,
      sessionId: this.userSession.sessionId,
      rtmpUrl,
      appId: packageName,
      streamId,
      video: video || {},
      audio: audio || {},
      stream: streamOptions || {},
      timestamp: now,
    };

    try {
      const messageSize = JSON.stringify(startMessage).length;
      this.logger.debug(
        {
          debugKey: "RTMP_STREAM_SEND_START_CMD",
          streamId,
          messageSize,
          packageName,
          rtmpUrl,
          sessionId: this.userSession.sessionId,
        },
        "RTMP_STREAM_SEND_START_CMD: UnmanagedStreamingExtension sending START_RTMP_STREAM message to glasses",
      );

      this.userSession.websocket.send(JSON.stringify(startMessage));
      this.logger.info(
        {
          debugKey: "RTMP_STREAM_START_CMD_SENT",
          streamId,
          packageName,
          rtmpUrl,
          sessionId: this.userSession.sessionId,
        },
        "RTMP_STREAM_START_CMD_SENT: UnmanagedStreamingExtension ✅ START_RTMP_STREAM successfully sent to glasses",
      );

      // Tell App we're starting (but not active yet)
      this.logger.debug(
        {
          debugKey: "RTMP_STREAM_NOTIFY_APP_INIT",
          streamId,
          sessionId: this.userSession.sessionId,
        },
        "RTMP_STREAM_NOTIFY_APP_INIT: UnmanagedStreamingExtension notifying App that stream is initializing",
      );
      await this.sendStreamStatusToApp(streamId, "initializing");
    } catch (error) {
      this.logger.error(
        {
          debugKey: "RTMP_STREAM_START_CMD_FAIL",
          error,
          streamId,
          packageName,
          sessionId: this.userSession.sessionId,
        },
        "RTMP_STREAM_START_CMD_FAIL: UnmanagedStreamingExtension ❌ Failed to send START_RTMP_STREAM to glasses",
      );
      this.stopTracking(streamId);
      throw error;
    }

    this.logger.info(
      {
        debugKey: "RTMP_STREAM_TRACKING_STARTED",
        streamId,
        packageName,
        rtmpUrl,
        sessionId: this.userSession.sessionId,
      },
      "RTMP_STREAM_TRACKING_STARTED: UnmanagedStreamingExtension 🎬 RTMP stream tracking started successfully",
    );
    return streamId;
  }

  /**
   * Update stream status (simplified from original)
   */
  async updateStatus(
    streamId: string,
    status: UnmanagedStreamStatus,
  ): Promise<void> {
    const runtime = this.unmanagedStreams.get(streamId);
    if (!runtime) {
      this.logger.warn(
        { streamId },
        "Attempted to update status for unknown stream",
      );
      return;
    }

    this.logger.info(
      { streamId, oldStatus: runtime.status, newStatus: status },
      "Updating stream status",
    );

    runtime.status = status;
    runtime.lastActivity = new Date();
    this.userSession.streamRegistry.updateLastActivity(this.userSession.userId);

    await this.sendStreamStatusToApp(streamId, status);

    if (status === "active") {
      runtime.lifecycle.setActive(true);
    } else if (status === "stopping") {
      runtime.lifecycle.setActive(false);
    }

    if (status === "stopped" || status === "timeout") {
      runtime.lifecycle.setActive(false);
      this.stopTracking(streamId);
    }
  }

  /**
   * Stop tracking a stream and clean up resources (from original)
   */
  stopTracking(streamId: string): void {
    const runtime = this.unmanagedStreams.get(streamId);
    if (!runtime) {
      return;
    }

    this.logger.info({ streamId }, "Stopping stream tracking");

    runtime.lifecycle.dispose();
    this.unmanagedStreams.delete(streamId);

    const currentStream = this.userSession.streamRegistry.getStreamState(
      this.userSession.userId,
    );
    if (
      currentStream &&
      currentStream.type === "unmanaged" &&
      currentStream.streamId === streamId
    ) {
      this.userSession.streamRegistry.removeStream(this.userSession.userId);
    }
  }

  /**
   * Stop streams by package name
   */
  stopStreamsByPackageName(packageName: string): void {
    for (const [streamId, stream] of this.unmanagedStreams) {
      if (stream.packageName === packageName) {
        void this.updateStatus(streamId, "stopped");
      }
    }
  }

  /**
   * Check if a stream is active (from original)
   */
  isStreamActive(streamId: string): boolean {
    const stream = this.unmanagedStreams.get(streamId);
    return stream ? ["initializing", "active"].includes(stream.status) : false;
  }

  /**
   * Get information about any active unmanaged streams for this session
   * Returns the first active stream found (there should only be one)
   */
  getActiveStreamInfo(): UnmanagedStreamRuntime | undefined {
    for (const [, stream] of this.unmanagedStreams) {
      if (["initializing", "active"].includes(stream.status)) {
        return stream;
      }
    }
    return undefined;
  }

  handleKeepAliveAck(ackMessage: KeepAliveAck): void {
    const { streamId, ackId } = ackMessage;
    this.logger.debug(
      { ackMessage, debugKey: "KEEP_ALIVE_ACK_RECEIVED" },
      "KEEP_ALIVE_ACK_RECEIVED Handling keep-alive ACK from glasses",
    );

    const stream = this.unmanagedStreams.get(streamId);
    if (!stream) {
      this.logger.warn({ streamId, ackId }, "Received ACK for unknown stream");
      return;
    }

    stream.lifecycle.handleAck(ackId);
    stream.lastActivity = new Date();
    this.userSession.streamRegistry.updateLastActivity(this.userSession.userId);
  }

  private createLifecycleController(
    streamId: string,
    packageName: string,
  ): StreamLifecycleController {
    const lifecycle = new StreamLifecycleController(
      {
        logger: this.logger.child({
          streamId,
          packageName,
          component: "UnmanagedLifecycle",
        }),
        streamId,
        keepAliveIntervalMs: KEEP_ALIVE_INTERVAL_MS,
        ackTimeoutMs: ACK_TIMEOUT_MS,
        maxMissedAcks: MAX_MISSED_ACKS,
        shouldSendKeepAlive: () =>
          !!this.userSession.websocket &&
          this.userSession.websocket.readyState === WebSocketReadyState.OPEN,
      },
      {
        sendKeepAlive: (ackId) => this.sendKeepAliveMessage(streamId, ackId),
        onTimeout: () => this.handleLifecycleTimeout(streamId),
        onKeepAliveSent: (ackId) => {
          this.logger.debug(
            { streamId, ackId },
            "Unmanaged stream keep-alive sent",
          );
        },
        onKeepAliveAcked: (ackId, ageMs) => {
          this.logger.debug(
            { streamId, ackId, ageMs },
            "Unmanaged stream keep-alive ACK received",
          );
        },
        onKeepAliveMissed: (ackId, ageMs, missed) => {
          this.logger.warn(
            { streamId, ackId, ageMs, missed },
            "Unmanaged stream keep-alive ACK missed",
          );
        },
      },
    );

    lifecycle.setActive(false);
    return lifecycle;
  }

  private async sendKeepAliveMessage(
    streamId: string,
    ackId: string,
  ): Promise<void> {
    if (
      !this.userSession.websocket ||
      this.userSession.websocket.readyState !== WebSocketReadyState.OPEN
    ) {
      this.logger.warn(
        { streamId },
        "Cannot send keep-alive because WebSocket is not open",
      );
      return;
    }

    const keepAliveMsg: KeepRtmpStreamAlive = {
      type: CloudToGlassesMessageType.KEEP_RTMP_STREAM_ALIVE,
      streamId,
      ackId,
    };

    try {
      this.userSession.websocket.send(JSON.stringify(keepAliveMsg));
    } catch (error) {
      this.logger.error(
        { error, streamId },
        "Failed to send keep-alive message",
      );
    }
  }

  private async handleLifecycleTimeout(streamId: string): Promise<void> {
    this.logger.warn(
      { streamId },
      "Unmanaged stream keep-alive timeout reached",
    );
    await this.updateStatus(streamId, "timeout");
  }

  private generateStreamId(): string {
    const timestamp = Date.now().toString(36).slice(-6);
    const random = Math.random().toString(36).slice(2, 6);
    return `s${timestamp}${random}`;
  }

  /**
   * Handle stream status update from glasses (simplified)
   */
  handleRtmpStreamStatus(statusMessage: RtmpStreamStatus): void {
    const { streamId, status } = statusMessage;
    this.logger.debug(
      { streamId, status, debugKey: "RTMP_STREAM_STATUS" },
      "RTMP_STREAM_STATUS Handling RTMP stream status update",
    );

    if (!streamId) {
      this.logger.warn(
        { statusMessage },
        "Received status message without streamId",
      );
      return;
    }

    const runtime = this.unmanagedStreams.get(streamId);
    if (!runtime) {
      this.logger.warn(
        { streamId, status },
        "Received status for unknown stream",
      );
      return;
    }

    runtime.lastActivity = new Date();
    runtime.lifecycle.recordActivity();

    if (!status) {
      this.logger.warn(
        { streamId },
        "Received status message without status value",
      );
      return;
    }

    let mappedStatus: UnmanagedStreamStatus;
    switch (status) {
      case "initializing":
      case "connecting":
      case "reconnecting":
        mappedStatus = "initializing";
        runtime.lifecycle.setActive(false);
        break;
      case "active":
      case "streaming":
      case "reconnected":
        mappedStatus = "active";
        runtime.lifecycle.setActive(true);
        break;
      case "stopping":
        mappedStatus = "stopping";
        runtime.lifecycle.setActive(false);
        break;
      case "stopped":
      case "disconnected":
        mappedStatus = "stopped";
        runtime.lifecycle.setActive(false);
        break;
      case "timeout":
        mappedStatus = "timeout";
        runtime.lifecycle.setActive(false);
        break;
      case "error":
        mappedStatus = "stopped";
        runtime.lifecycle.setActive(false);
        this.logger.error(
          { streamId, status },
          "Stream error received from glasses",
        );
        break;
      case "reconnect_failed":
        mappedStatus = "stopped";
        runtime.lifecycle.setActive(false);
        this.logger.warn({ streamId, status }, "Stream reconnection failed");
        break;
      default:
        mappedStatus = "stopped";
        runtime.lifecycle.setActive(false);
        this.logger.warn(
          { streamId, status },
          "Received unknown status from glasses, defaulting to stopped",
        );
        break;
    }

    void this.updateStatus(streamId, mappedStatus);
  }

  /**
   * Handles a request from a App to stop an RTMP stream.
   */
  async stopRtmpStream(request: RtmpStreamStopRequest): Promise<void> {
    const { packageName, streamId } = request;
    this.logger.info(
      { packageName, streamId },
      "Processing stop RTMP stream request",
    );

    if (streamId) {
      // Stop specific stream
      const stream = this.unmanagedStreams.get(streamId);
      if (stream && stream.packageName === packageName) {
        await this.updateStatus(streamId, "stopped");
      } else if (stream) {
        throw new Error(
          `App ${packageName} cannot stop stream ${streamId} owned by ${stream.packageName}`,
        );
      } else {
        this.logger.warn(
          { streamId, packageName },
          "Request to stop non-existent stream",
        );
      }
    } else {
      // Stop all streams for this package
      this.stopStreamsByPackageName(packageName);
    }

    // Send stop command to glasses if WebSocket is connected
    if (
      this.userSession.websocket &&
      this.userSession.websocket.readyState === WebSocketReadyState.OPEN
    ) {
      const stopMessage: StopRtmpStream = {
        type: CloudToGlassesMessageType.STOP_RTMP_STREAM,
        sessionId: this.userSession.sessionId,
        appId: packageName,
        streamId: streamId || "",
        timestamp: new Date(),
      };

      try {
        this.userSession.websocket.send(JSON.stringify(stopMessage));
        this.logger.info(
          { packageName, streamId },
          "STOP_RTMP_STREAM sent to glasses",
        );
      } catch (error) {
        this.logger.error(
          { error, packageName, streamId },
          "Failed to send stop command to glasses",
        );
      }
    }
  }

  /**
   * Sends stream status to the owning App and broadcasts to other subscribers.
   */
  private async sendStreamStatusToApp(
    streamId: string,
    status: RtmpStreamStatus["status"], // This is the status string from SDK
    errorDetails?: string,
    stats?: RtmpStreamStatus["stats"],
  ): Promise<void> {
    const streamInfo = this.unmanagedStreams.get(streamId);
    // It's possible streamInfo is gone if cleanup happened due to rapid events.
    const packageName = streamInfo
      ? streamInfo.packageName
      : "unknown_package_owner";

    // Direct message to the App that owns the stream
    const appOwnerMessage = {
      type: CloudToAppMessageType.RTMP_STREAM_STATUS,
      sessionId: `${this.userSession.sessionId}-${packageName}`,
      streamId,
      status, // The SDK status string
      errorDetails,
      stats,
      appId: packageName, // Clarify which app this status pertains to
      timestamp: new Date(),
    };

    // Send status to owning App using centralized messaging
    try {
      const result = await this.userSession.appManager.sendMessageToApp(
        packageName,
        appOwnerMessage,
      );

      if (result.sent) {
        this.logger.debug(
          {
            streamId,
            status,
            target: packageName,
            resurrectionTriggered: result.resurrectionTriggered,
          },
          `Sent RTMP status to owning App ${packageName}${result.resurrectionTriggered ? " after resurrection" : ""}`,
        );
      } else {
        this.logger.warn(
          {
            streamId,
            status,
            target: packageName,
            resurrectionTriggered: result.resurrectionTriggered,
            error: result.error,
          },
          `Failed to send RTMP status to owning App ${packageName}`,
        );
      }
    } catch (error) {
      this.logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          streamId,
          target: packageName,
        },
        `Error sending RTMP status to owning App ${packageName}`,
      );
    }

    // Broadcast DataStream to other subscribed Apps
    const broadcastPayload: RtmpStreamStatus = {
      type: GlassesToCloudMessageType.RTMP_STREAM_STATUS,
      sessionId: this.userSession.sessionId,
      streamId,
      status,
      errorDetails,
      appId: packageName,
      stats,
      timestamp: new Date(),
    };

    // Relay to Apps who subscribed to this RTMP stream
    this.userSession.relayMessageToApps(broadcastPayload);

    this.logger.debug(
      { streamId, status },
      "Broadcast RTMP status via DataStream",
    );
  }

  /**
   * Called when the UserSession is ending.
   */
  dispose(): void {
    this.logger.info(
      "Disposing UnmanagedStreamingExtension, stopping all active streams for this session",
    );
    const streamIdsToStop = Array.from(this.unmanagedStreams.keys());
    streamIdsToStop.forEach((streamId) => {
      this.stopTracking(streamId);
    });
    this.unmanagedStreams.clear();
  }
}

export default UnmanagedStreamingExtension;
