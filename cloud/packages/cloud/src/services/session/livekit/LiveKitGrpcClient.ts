import path from "path";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { Logger } from "pino";

import { ResourceTracker } from "../../../utils/resource-tracker";
import UserSession from "../UserSession";

/**
 * LiveKitGrpcClient - gRPC client for Go livekit-bridge
 *
 * Replaces WebSocket-based LiveKitClient with gRPC bidirectional streaming.
 * - Handles audio streaming to/from LiveKit room via Go bridge
 * - Server-side audio playback (MP3/WAV)
 * - Built-in HTTP/2 flow control and backpressure
 * - No manual reconnection logic (gRPC handles it)
 */

interface JoinRoomParams {
  url: string;
  roomName: string;
  token: string;
  targetIdentity?: string;
}

interface PlayAudioParams {
  requestId: string;
  url: string;
  volume?: number;
  stopOther?: boolean;
  trackId?: number; // Track ID for audio routing (0=speaker, 1=app_audio, 2=tts)
}

interface PlayAudioEvent {
  type: "STARTED" | "PROGRESS" | "COMPLETED" | "FAILED";
  requestId: string;
  durationMs?: number;
  positionMs?: number;
  error?: string;
  metadata?: Record<string, string>;
}

export class LiveKitGrpcClient {
  private readonly logger: Logger;
  private readonly userSession: UserSession;
  private readonly bridgeUrl: string;
  private client: any; // LiveKitBridge gRPC client
  private audioStream: grpc.ClientDuplexStream<any, any> | null = null;
  private connected = false;
  private connecting = false;
  private disposed = false;
  private joinedRoom = false;
  private currentParams: JoinRoomParams | null = null;
  private eventHandlers: Map<string, (evt: PlayAudioEvent) => void> = new Map();
  private resources = new ResourceTracker();

  // Endianness handling: "swap" to force byte swapping, "off" for no swapping (default)
  private readonly shouldSwapBytes: boolean;

  constructor(userSession: UserSession, bridgeUrl?: string) {
    this.userSession = userSession;
    this.logger = userSession.logger.child({
      service: "LiveKitGrpcClient",
      feature: "livekit-grpc",
    });

    // Support Unix socket or TCP connection
    // If LIVEKIT_GRPC_SOCKET is set, use Unix socket with unix: prefix
    const socketPath = process.env.LIVEKIT_GRPC_SOCKET;
    if (socketPath) {
      this.bridgeUrl = `unix:${socketPath}`;
    } else {
      this.bridgeUrl = bridgeUrl || process.env.LIVEKIT_GRPC_BRIDGE_URL || "livekit-bridge:9090";
    }

    // Initialize endianness mode from environment: "swap" or "off" (default)
    const mode = (process.env.LIVEKIT_PCM_ENDIAN || "off").toLowerCase();
    this.shouldSwapBytes = mode === "swap";

    if (this.shouldSwapBytes) {
      this.logger.info(
        { feature: "livekit-grpc" },
        "Endianness: SWAP mode enabled - will convert big-endian to little-endian",
      );
    } else {
      this.logger.info({ feature: "livekit-grpc" }, "Endianness: OFF mode - no byte swapping");
    }

    // Load proto and create gRPC client
    this.initializeGrpcClient();
  }

  private initializeGrpcClient(): void {
    try {
      // Path to proto file (relative to this file or absolute)
      // Proto file is copied to cloud/packages/cloud/proto/
      const PROTO_PATH = path.resolve(__dirname, "../../../../proto/livekit_bridge.proto");

      // Load proto definition
      const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
      });

      const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
      const livekitProto = (protoDescriptor.mentra as any).livekit.bridge;

      // Create insecure client (internal network or Unix socket)
      // gRPC-JS automatically handles unix: prefix for Unix domain sockets
      this.client = new livekitProto.LiveKitBridge(this.bridgeUrl, grpc.credentials.createInsecure());

      this.logger.info(
        {
          bridgeUrl: this.bridgeUrl,
          userId: this.userSession.userId,
          feature: "livekit-grpc",
        },
        "gRPC client initialized",
      );
    } catch (error) {
      this.logger.error({ error, bridgeUrl: this.bridgeUrl }, "Failed to initialize gRPC client");
      throw error;
    }
  }

  async connect(params: JoinRoomParams): Promise<void> {
    if (this.disposed) {
      throw new Error("LiveKitGrpcClient is disposed");
    }

    if (this.connecting) {
      this.logger.warn("Connection already in progress, skipping duplicate call");
      return;
    }

    if (this.joinedRoom) {
      this.logger.warn("Already connected to room, disconnecting first");
      await this.disconnect();
    }

    this.connecting = true;
    this.currentParams = params;

    // Join room via gRPC
    await this.joinRoom(params);

    // Start bidirectional audio stream
    await this.startAudioStream();

    this.connected = true;
    this.connecting = false;
    this.logger.info(
      {
        room: params.roomName,
        target: params.targetIdentity,
        feature: "livekit-grpc",
      },
      "Connected to LiveKit room via gRPC",
    );
  }

  private async joinRoom(params: JoinRoomParams): Promise<void> {
    return new Promise((resolve, reject) => {
      // Ensure connecting flag is reset on error
      const handleError = (error: any) => {
        this.connecting = false;
        reject(error);
      };
      const request = {
        user_id: this.userSession.userId,
        room_name: params.roomName,
        token: params.token,
        livekit_url: params.url,
        target_identity: params.targetIdentity || this.userSession.userId,
      };

      this.logger.debug(
        {
          request,
          feature: "livekit-grpc",
        },
        "Calling JoinRoom RPC",
      );

      this.client.joinRoom(request, (error: grpc.ServiceError | null, response: any) => {
        if (error) {
          this.logger.error(
            {
              error,
              feature: "livekit-grpc",
            },
            "JoinRoom RPC failed",
          );
          handleError(error);
          return;
        }

        if (!response.success) {
          this.logger.error(
            {
              response,
              feature: "livekit-grpc",
            },
            "JoinRoom returned failure",
          );
          handleError(new Error(response.error || "Failed to join room"));
          return;
        }

        this.joinedRoom = true;
        this.logger.info(
          {
            participantId: response.participant_id,
            participantCount: response.participant_count,
            feature: "livekit-grpc",
          },
          "Joined LiveKit room",
        );
        resolve();
      });
    });
  }

  private async startAudioStream(): Promise<void> {
    if (this.audioStream) {
      this.logger.warn(
        {
          feature: "livekit-grpc",
        },
        "Audio stream already exists, closing first",
      );
      this.audioStream.end();
      this.audioStream = null;
    }

    this.audioStream = this.client.streamAudio();

    // Send initial chunk with user_id to establish stream
    const initialChunk = {
      user_id: this.userSession.userId,
      pcm_data: Buffer.alloc(0), // Empty initial frame
      sample_rate: 16000,
      channels: 1,
      timestamp_ms: Date.now(),
    };

    this.audioStream?.write(initialChunk);

    // Handle incoming audio from LiveKit → TypeScript
    let receivedChunks = 0;
    const dataHandler = (chunk: any) => {
      if (this.disposed) return;
      try {
        let pcmData = Buffer.from(chunk.pcm_data);

        // Swap bytes if mode is "swap"
        if (this.shouldSwapBytes && pcmData.length >= 2) {
          pcmData = this.swapBytes(pcmData);
        }

        receivedChunks++;
        if (receivedChunks % 100 === 0) {
          // Log sample values to verify endianness
          const sampleCount = Math.min(8, Math.floor(pcmData.length / 2));
          const i16 = new Int16Array(pcmData.buffer, pcmData.byteOffset, Math.floor(pcmData.byteLength / 2));
          const headSamples: number[] = Array.from(i16.slice(0, sampleCount));

          this.logger.debug(
            {
              receivedChunks,
              chunkSize: pcmData.length,
              userId: this.userSession.userId,
              headBytes: Array.from(pcmData.slice(0, 10)),
              headSamples,
              feature: "livekit-grpc",
            },
            "Received audio chunks from gRPC bridge",
          );
        }

        // Forward to AudioManager (PCM16LE @ 16kHz, mono)
        this.userSession.audioManager.processAudioData(pcmData);
      } catch (error) {
        this.logger.warn(
          {
            error,
            feature: "livekit-grpc",
          },
          "Failed to process audio chunk from bridge",
        );
      }
    };

    // Handle stream errors
    const errorHandler = (error: Error) => {
      if (this.disposed) return;
      this.logger.error(
        {
          error,
          feature: "livekit-grpc",
        },
        "Audio stream error",
      );
      this.connected = false;

      // Attempt reconnection if not disposed
      if (!this.disposed && this.currentParams) {
        this.logger.info(
          {
            feature: "livekit-grpc",
          },
          "Attempting to reconnect after stream error",
        );
        setTimeout(() => {
          if (this.currentParams && !this.disposed) {
            this.connect(this.currentParams).catch((err) => {
              this.logger.error(
                {
                  err,
                  feature: "livekit-grpc",
                },
                "Reconnection failed",
              );
            });
          }
        }, 2000);
      }
    };

    // Handle stream end
    const endHandler = () => {
      if (this.disposed) return;
      this.logger.info(
        {
          feature: "livekit-grpc",
        },
        "Audio stream ended",
      );
      this.connected = false;
      this.audioStream = null;
    };

    // Attach handlers
    this.audioStream?.on("data", dataHandler);
    this.audioStream?.on("error", errorHandler);
    this.audioStream?.on("end", endHandler);

    // Track handlers for cleanup
    this.resources.track(() => {
      if (this.audioStream) {
        this.audioStream.off("data", dataHandler);
        this.audioStream.off("error", errorHandler);
        this.audioStream.off("end", endHandler);
      }
    });

    this.logger.info(
      {
        userId: this.userSession.userId,
        feature: "livekit-grpc",
      },
      "Audio stream started, listening for audio from bridge",
    );
  }

  /**
   * Analyze first chunk for debugging
   */
  private analyzeFirstChunk(pcmData: Buffer): void {
    this.logger.info(
      {
        feature: "livekit-grpc",
        length: pcmData.length,
        firstBytes: Array.from(pcmData.slice(0, 32)),
      },
      "First audio chunk received - raw bytes",
    );

    // Interpret as little-endian int16
    const asLE = new Int16Array(pcmData.buffer, pcmData.byteOffset, Math.min(16, Math.floor(pcmData.byteLength / 2)));
    const samplesLE = Array.from(asLE);

    // Interpret as big-endian int16 (manually swap)
    const samplesLE_swapped: number[] = [];
    for (let i = 0; i + 1 < Math.min(32, pcmData.length); i += 2) {
      const swapped = (pcmData[i + 1] << 8) | pcmData[i];
      samplesLE_swapped.push(swapped > 32767 ? swapped - 65536 : swapped);
    }

    this.logger.info(
      {
        feature: "livekit-grpc",
        asLittleEndian: samplesLE,
        asBigEndian: samplesLE_swapped,
      },
      "First chunk - interpreted both ways",
    );
  }

  /**
   * Swap bytes for endianness conversion (big-endian to little-endian)
   */
  private swapBytes(buf: Buffer): Buffer {
    // Ensure even-length buffer
    if (buf.length % 2 === 1) {
      buf = buf.slice(0, buf.length - 1);
    }

    if (buf.length < 2) {
      return buf;
    }

    // Swap bytes in-place
    for (let i = 0; i < buf.length; i += 2) {
      const tmp = buf[i];
      buf[i] = buf[i + 1];
      buf[i + 1] = tmp;
    }

    return buf;
  }

  /**
   * Send audio chunk to LiveKit room via gRPC stream
   * This is called by TypeScript when we want to send audio TO the bridge
   */
  public sendAudioChunk(pcmData: Buffer): void {
    if (!this.audioStream || this.disposed || !this.connected) {
      return;
    }

    try {
      const chunk = {
        user_id: this.userSession.userId,
        pcm_data: pcmData,
        sample_rate: 16000,
        channels: 1,
        timestamp_ms: Date.now(),
      };

      this.audioStream?.write(chunk);
    } catch (error) {
      this.logger.warn(
        {
          error,
          feature: "livekit-grpc",
        },
        "Failed to send audio chunk to bridge",
      );
    }
  }

  /**
   * Play audio from URL via server-side bridge
   */
  public playAudio(params: PlayAudioParams): void {
    if (!this.client || this.disposed) {
      this.logger.warn(
        {
          feature: "livekit-grpc",
        },
        "Cannot play audio: client not initialized",
      );
      return;
    }

    const request = {
      request_id: params.requestId,
      audio_url: params.url,
      volume: params.volume ?? 1.0,
      stop_other: params.stopOther ?? false,
      user_id: this.userSession.userId,
      track_id: params.trackId ?? 0, // Default to track 0 (speaker)
    };

    this.logger.info(
      {
        request,
        feature: "livekit-grpc",
      },
      "Calling PlayAudio RPC",
    );

    // PlayAudio returns a stream of events
    const stream = this.client.playAudio(request);

    stream.on("data", (event: any) => {
      if (this.disposed) return;
      const playEvent: PlayAudioEvent = {
        type: this.mapEventType(event.type),
        requestId: event.request_id,
        durationMs: event.duration_ms,
        positionMs: event.position_ms,
        error: event.error,
        metadata: event.metadata,
      };

      this.logger.debug(
        {
          event: playEvent,
          feature: "livekit-grpc",
        },
        "PlayAudio event",
      );

      // Notify event handler if registered
      const handler = this.eventHandlers.get(params.requestId);
      if (handler) {
        handler(playEvent);
      }

      // Clean up handler on completion or failure
      if (playEvent.type === "COMPLETED" || playEvent.type === "FAILED") {
        this.eventHandlers.delete(params.requestId);
      }
    });

    stream.on("error", (error: Error) => {
      if (this.disposed) return;
      this.logger.error(
        {
          error,
          requestId: params.requestId,
          feature: "livekit-grpc",
        },
        "PlayAudio stream error",
      );

      const handler = this.eventHandlers.get(params.requestId);
      if (handler) {
        handler({
          type: "FAILED",
          requestId: params.requestId,
          error: error.message,
        });
        this.eventHandlers.delete(params.requestId);
      }
    });

    stream.on("end", () => {
      if (this.disposed) return;
      this.logger.debug(
        {
          requestId: params.requestId,
          feature: "livekit-grpc",
        },
        "PlayAudio stream ended",
      );
    });
  }

  /**
   * Stop audio playback
   */
  public stopAudio(requestId?: string): void {
    if (!this.client || this.disposed) {
      return;
    }

    const request = {
      user_id: this.userSession.userId,
      request_id: requestId || "",
      reason: "User requested stop",
    };

    this.client.stopAudio(request, (error: grpc.ServiceError | null, response: any) => {
      if (error) {
        this.logger.error(
          {
            error,
            feature: "livekit-grpc",
          },
          "StopAudio RPC failed",
        );
        return;
      }

      this.logger.info(
        {
          stoppedRequestId: response.stopped_request_id,
          feature: "livekit-grpc",
        },
        "Audio playback stopped",
      );
    });
  }

  /**
   * Register event handler for PlayAudio events
   */
  public onPlayAudioEvent(requestId: string, handler: (evt: PlayAudioEvent) => void): void {
    this.eventHandlers.set(requestId, handler);
  }

  /**
   * Enable subscription to target identity
   */
  public enableSubscribe(targetIdentity: string): void {
    // In gRPC version, subscription is handled during JoinRoom
    // This method is kept for API compatibility but is a no-op
    this.logger.debug(
      {
        targetIdentity,
        feature: "livekit-grpc",
      },
      "enableSubscribe called (no-op in gRPC version)",
    );
  }

  /**
   * Disable subscription
   */
  public disableSubscribe(): void {
    // In gRPC version, subscription is controlled by stream lifecycle
    // This method is kept for API compatibility but is a no-op
    this.logger.debug(
      {
        feature: "livekit-grpc",
      },
      "disableSubscribe called (no-op in gRPC version)",
    );
  }

  /**
   * Check if connected
   */
  public isConnected(): boolean {
    return this.connected && this.joinedRoom && !!this.audioStream;
  }

  /**
   * Check if connection is in progress
   */
  public isConnecting(): boolean {
    return this.connecting;
  }

  /**
   * Get bridge room connectivity status for this user.
   */
  public async getStatus(): Promise<any> {
    return new Promise((resolve, _reject) => {
      if (this.disposed || !this.client) {
        resolve({
          connected: false,
          participant_id: "",
          participant_count: 0,
          last_disconnect_at: 0,
          last_disconnect_reason: "client_disposed",
          server_version: "",
        });
        return;
      }
      const req = { user_id: this.userSession.userId };
      try {
        this.client.getStatus(req, (err: grpc.ServiceError | null, res: any) => {
          if (err) {
            this.logger.child({ feature: "livekit-grpc" }).error(err, "GetStatus RPC failed");
            resolve({
              connected: false,
              participant_id: "",
              participant_count: 0,
              last_disconnect_at: 0,
              last_disconnect_reason: "rpc_error",
              server_version: "",
            });
            return;
          }
          resolve(res);
        });
      } catch (e) {
        this.logger.child({ feature: "livekit-grpc" }).error(e, "GetStatus threw");
        resolve({
          connected: false,
          participant_id: "",
          participant_count: 0,
          last_disconnect_at: 0,
          last_disconnect_reason: "exception",
          server_version: "",
        });
      }
    });
  }

  /**
   * Rejoin the LiveKit room (used on reconnect when the bridge was kicked).
   * Manager should mint a fresh token and pass params; falls back to currentParams.
   */
  public async rejoin(params?: JoinRoomParams): Promise<void> {
    const p = params ?? this.currentParams;
    if (!p) {
      throw new Error("rejoin called without params and no previous room params");
    }
    // If already joined, perform a clean disconnect first
    if (this.joinedRoom) {
      await this.disconnect();
    }
    this.connecting = true;
    this.currentParams = p;
    await this.joinRoom(p);
    await this.startAudioStream();
    this.connected = true;
    this.connecting = false;
    this.logger.info(
      { room: p.roomName, target: p.targetIdentity, feature: "livekit-grpc" },
      "Rejoined LiveKit room via gRPC",
    );
  }

  /**
   * Disconnect from room
   */
  public async disconnect(): Promise<void> {
    if (!this.joinedRoom) {
      return;
    }

    // Close audio stream
    if (this.audioStream) {
      this.audioStream.end();
      this.audioStream = null;
    }

    // Leave room
    if (this.client) {
      return new Promise((resolve) => {
        const request = {
          user_id: this.userSession.userId,
          reason: "User disconnected",
        };

        this.client.leaveRoom(request, (error: grpc.ServiceError | null, _response: any) => {
          if (error) {
            this.logger.error(
              {
                error,
                feature: "livekit-grpc",
              },
              "LeaveRoom RPC failed",
            );
          } else {
            this.logger.info(
              {
                feature: "livekit-grpc",
              },
              "Left LiveKit room",
            );
          }

          this.joinedRoom = false;
          this.connected = false;
          this.currentParams = null;
          resolve();
        });
      });
    }

    this.joinedRoom = false;
    this.connected = false;
    this.currentParams = null;
  }

  /**
   * Dispose of client (cleanup)
   */
  public dispose(): void {
    if (this.disposed) return; // Idempotent
    this.disposed = true;

    // Clean up all tracked resources (removes event listeners)
    this.resources.dispose();

    void this.disconnect();
    this.eventHandlers.clear();

    if (this.client) {
      // gRPC client doesn't have explicit close, channels are managed automatically
      this.client = null;
    }
  }

  /**
   * Map proto event type to TypeScript enum
   */
  private mapEventType(protoType: number): "STARTED" | "PROGRESS" | "COMPLETED" | "FAILED" {
    switch (protoType) {
      case 0:
        return "STARTED";
      case 1:
        return "PROGRESS";
      case 2:
        return "COMPLETED";
      case 3:
        return "FAILED";
      default:
        return "FAILED";
    }
  }

  /**
   * Legacy compatibility: set event handler (used by old WebSocket client)
   */
  public onEvent(_handler: (evt: any) => void): void {
    // Convert to new event system
    this.logger.debug(
      {
        feature: "livekit-grpc",
      },
      "onEvent called (legacy compatibility mode)",
    );
    // In the new system, events are handled per-request via onPlayAudioEvent
    // This is a simplified compatibility shim
  }

  /**
   * Legacy compatibility: play URL (used by old WebSocket client)
   */
  public playUrl(params: {
    requestId: string;
    url: string;
    volume?: number;
    stopOther?: boolean;
    trackId?: number; // Track ID for audio routing (0=speaker, 1=app_audio, 2=tts)
  }): void {
    this.playAudio(params);
  }

  /**
   * Legacy compatibility: stop playback
   */
  public stopPlayback(requestId?: string): void {
    this.stopAudio(requestId);
  }
}

export default LiveKitGrpcClient;
