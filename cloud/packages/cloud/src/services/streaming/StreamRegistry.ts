import { Logger } from "pino";
import { VideoConfig, AudioConfig, StreamConfig } from "@mentra/sdk";
import { LiveInputResult, CloudflareOutput } from "./CloudflareStreamService";

/**
 * Stream types supported by the system
 */
export type StreamType = "managed" | "unmanaged";

/**
 * Base stream state information
 */
interface BaseStreamState {
  userId: string;
  type: StreamType;
  createdAt: Date;
  lastActivity: Date;
}

/**
 * Managed stream state with relay integration
 */
export interface ManagedStreamState extends BaseStreamState {
  type: "managed";
  cfLiveInputId: string; // Keep for compatibility but use streamId value
  cfIngestUrl: string; // Keep for compatibility but empty
  hlsUrl: string; // Will be set by relay
  dashUrl: string; // Will be set by relay
  webrtcUrl?: string; // Not used in relay mode
  activeViewers: Set<string>; // Set of appIds consuming this stream
  streamId: string; // Internal stream ID
  outputs?: Array<{
    cfOutputId: string;
    url: string;
    name?: string;
    addedBy: string; // packageName of TPA that added it
    status?: CloudflareOutput;
  }>; // Restream outputs if configured
}

/**
 * Unmanaged stream state (existing RTMP)
 */
export interface UnmanagedStreamState extends BaseStreamState {
  type: "unmanaged";
  rtmpUrl: string;
  requestingAppId: string;
  streamId: string;
  options?: {
    video?: VideoConfig;
    audio?: AudioConfig;
    stream?: StreamConfig;
  };
}

/**
 * Union type for all stream states
 */
export type StreamState = ManagedStreamState | UnmanagedStreamState;

/**
 * Options for creating a managed stream
 */
export interface CreateManagedStreamOptions {
  userId: string;
  appId: string;
  liveInput: LiveInputResult;
}

export interface CreateUnmanagedStreamOptions {
  userId: string;
  appId: string;
  rtmpUrl: string;
  streamId?: string;
  video?: VideoConfig;
  audio?: AudioConfig;
  stream?: StreamConfig;
}

/**
 * Result of checking stream conflicts
 */
export interface StreamConflictResult {
  hasConflict: boolean;
  conflictType?: StreamType;
  message?: string;
}

/**
 * Manages in-memory state for both managed and unmanaged streams
 * Enforces single stream per user constraint
 */
export class StreamRegistry {
  private logger: Logger;

  // Map of userId -> current stream state
  private userStreams: Map<string, StreamState>;

  // Map of streamId -> userId for quick lookups
  private streamToUser: Map<string, string>;

  // Map of cfLiveInputId -> userId for Cloudflare stream lookups
  private cfInputToUser: Map<string, string>;

  constructor(logger: Logger) {
    this.logger = logger.child({ service: "StreamRegistry" });
    this.userStreams = new Map();
    this.streamToUser = new Map();
    this.cfInputToUser = new Map();
  }

  /**
   * Check if a user has any active stream
   */
  hasActiveStream(userId: string): boolean {
    return this.userStreams.has(userId);
  }

  /**
   * Get the current stream state for a user
   */
  getStreamState(userId: string): StreamState | undefined {
    return this.userStreams.get(userId);
  }

  /**
   * Check for stream conflicts before starting a new stream
   */
  checkStreamConflict(
    userId: string,
    newStreamType: StreamType,
  ): StreamConflictResult {
    const currentStream = this.userStreams.get(userId);

    if (!currentStream) {
      return { hasConflict: false };
    }

    if (currentStream.type === newStreamType) {
      if (newStreamType === "managed") {
        // Managed streams can have multiple viewers
        return { hasConflict: false };
      } else {
        // Unmanaged streams are exclusive
        return {
          hasConflict: true,
          conflictType: "unmanaged",
          message: "Unmanaged stream already active for this user",
        };
      }
    }

    // Different type - conflict
    return {
      hasConflict: true,
      conflictType: currentStream.type,
      message: `Cannot start ${newStreamType} stream - ${currentStream.type} stream already active`,
    };
  }

  /**
   * Create a new managed stream or add viewer to existing
   */
  createOrJoinManagedStream(
    options: CreateManagedStreamOptions,
  ): ManagedStreamState {
    const { userId, appId, liveInput } = options;

    // Check if user already has a managed stream
    const existingStream = this.userStreams.get(userId);

    if (existingStream && existingStream.type === "managed") {
      // Add viewer to existing stream
      existingStream.activeViewers.add(appId);
      existingStream.lastActivity = new Date();

      this.logger.info(
        {
          userId,
          appId,
          viewerCount: existingStream.activeViewers.size,
        },
        "Added viewer to existing managed stream",
      );

      return existingStream;
    }

    // Create new managed stream
    const streamId = this.generateStreamId();
    const managedStream: ManagedStreamState = {
      userId,
      type: "managed",
      cfLiveInputId: liveInput.liveInputId,
      cfIngestUrl: liveInput.rtmpUrl,
      hlsUrl: liveInput.hlsUrl,
      dashUrl: liveInput.dashUrl,
      webrtcUrl: liveInput.webrtcUrl,
      activeViewers: new Set([appId]),
      streamId,
      createdAt: new Date(),
      lastActivity: new Date(),
      outputs: liveInput.outputs?.map((output) => ({
        cfOutputId: output.uid,
        url: output.url,
        name: undefined, // Will be set later if needed
        addedBy: appId, // Initial outputs are owned by the app that created the stream
        status: output,
      })),
    };

    // Update all maps
    this.userStreams.set(userId, managedStream);
    this.streamToUser.set(streamId, userId);
    this.cfInputToUser.set(liveInput.liveInputId, userId);

    this.logger.info(
      {
        userId,
        appId,
        streamId,
        cfLiveInputId: liveInput.liveInputId,
      },
      "Created new managed stream",
    );

    return managedStream;
  }

  /**
   * Remove a viewer from a managed stream
   */
  removeViewerFromManagedStream(userId: string, appId: string): boolean {
    const stream = this.userStreams.get(userId);

    if (!stream || stream.type !== "managed") {
      return false;
    }

    stream.activeViewers.delete(appId);
    stream.lastActivity = new Date();

    this.logger.info(
      {
        userId,
        appId,
        remainingViewers: stream.activeViewers.size,
      },
      "Removed viewer from managed stream",
    );

    // If no viewers left, stream should be cleaned up
    return stream.activeViewers.size === 0;
  }

  /**
   * Create an unmanaged stream
   */
  createUnmanagedStream(
    options: CreateUnmanagedStreamOptions,
  ): UnmanagedStreamState {
    const {
      userId,
      appId,
      rtmpUrl,
      streamId: providedStreamId,
      video,
      audio,
      stream,
    } = options;

    const streamId = providedStreamId ?? this.generateStreamId("s");

    const optionsPayload =
      video || audio || stream
        ? {
            video,
            audio,
            stream,
          }
        : undefined;

    const unmanagedStream: UnmanagedStreamState = {
      userId,
      type: "unmanaged",
      rtmpUrl,
      requestingAppId: appId,
      streamId,
      createdAt: new Date(),
      lastActivity: new Date(),
      options: optionsPayload,
    };

    // Update maps
    this.userStreams.set(userId, unmanagedStream);
    this.streamToUser.set(streamId, userId);

    this.logger.info(
      {
        userId,
        appId,
        streamId,
      },
      "Created unmanaged stream",
    );

    return unmanagedStream;
  }

  /**
   * Remove any stream for a user
   */
  removeStream(userId: string): StreamState | undefined {
    const stream = this.userStreams.get(userId);

    if (!stream) {
      return undefined;
    }

    // Clean up all references
    this.userStreams.delete(userId);
    this.streamToUser.delete(stream.streamId);

    if (stream.type === "managed") {
      this.cfInputToUser.delete(stream.cfLiveInputId);
    }

    this.logger.info(
      {
        userId,
        streamType: stream.type,
        streamId: stream.streamId,
      },
      "Removed stream",
    );

    return stream;
  }

  /**
   * Update stream URLs when HLS becomes available
   */
  updateStreamUrls(userId: string, hlsUrl: string, dashUrl?: string): void {
    const stream = this.userStreams.get(userId);
    if (!stream || stream.type !== "managed") {
      return;
    }

    stream.hlsUrl = hlsUrl;
    if (dashUrl) {
      stream.dashUrl = dashUrl;
    }
    stream.lastActivity = new Date();

    this.logger.info(
      {
        userId,
        streamId: stream.streamId,
        hlsUrl,
        dashUrl,
      },
      "Updated stream URLs",
    );
  }

  /**
   * Get all active Cloudflare live input IDs
   * @deprecated Not used in relay mode
   */
  getActiveCfLiveInputIds(): Set<string> {
    const ids = new Set<string>();

    for (const stream of this.userStreams.values()) {
      if (stream.type === "managed") {
        ids.add(stream.cfLiveInputId);
      }
    }

    return ids;
  }

  /**
   * Get stream state by stream ID
   */
  getStreamByStreamId(streamId: string): StreamState | undefined {
    const userId = this.streamToUser.get(streamId);
    return userId ? this.userStreams.get(userId) : undefined;
  }

  /**
   * Get stream state by Cloudflare live input ID
   */
  getStreamByCfInputId(cfLiveInputId: string): ManagedStreamState | undefined {
    const userId = this.cfInputToUser.get(cfLiveInputId);
    if (!userId) return undefined;

    const stream = this.userStreams.get(userId);
    return stream?.type === "managed" ? stream : undefined;
  }

  /**
   * Update last activity timestamp
   */
  updateLastActivity(userId: string): void {
    const stream = this.userStreams.get(userId);
    if (stream) {
      stream.lastActivity = new Date();
    }
  }

  /**
   * Get all streams (for monitoring/debugging)
   */
  getAllStreams(): StreamState[] {
    return Array.from(this.userStreams.values());
  }

  /**
   * Get stream statistics
   */
  getStats(): {
    totalStreams: number;
    managedStreams: number;
    unmanagedStreams: number;
    totalViewers: number;
  } {
    let managedStreams = 0;
    let unmanagedStreams = 0;
    let totalViewers = 0;

    for (const stream of this.userStreams.values()) {
      if (stream.type === "managed") {
        managedStreams++;
        totalViewers += stream.activeViewers.size;
      } else {
        unmanagedStreams++;
        totalViewers++; // Unmanaged streams have single viewer
      }
    }

    return {
      totalStreams: this.userStreams.size,
      managedStreams,
      unmanagedStreams,
      totalViewers,
    };
  }

  /**
   * Clean up streams older than specified age
   */
  cleanupInactiveStreams(maxAgeMinutes: number = 60): string[] {
    const removedUserIds: string[] = [];
    const cutoffTime = Date.now() - maxAgeMinutes * 60 * 1000;

    for (const [userId, stream] of this.userStreams.entries()) {
      if (stream.lastActivity.getTime() < cutoffTime) {
        this.removeStream(userId);
        removedUserIds.push(userId);
      }
    }

    if (removedUserIds.length > 0) {
      this.logger.info(
        {
          count: removedUserIds.length,
          maxAgeMinutes,
        },
        "Cleaned up inactive streams",
      );
    }

    return removedUserIds;
  }

  /**
   * Generate a unique stream ID
   * Using shorter format to reduce BLE message size
   */
  private generateStreamId(prefix: string = "m"): string {
    // Short format: prefix + 6 char timestamp + 4 random chars = ~11 chars total
    const timestamp = Date.now().toString(36).slice(-6);
    const random = Math.random().toString(36).slice(2, 6);
    return `${prefix}${timestamp}${random}`;
  }
}
