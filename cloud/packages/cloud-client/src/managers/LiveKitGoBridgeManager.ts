import WebSocket from "ws";
import { EventEmitter } from "events";

interface GoBridgeConfig {
  userId: string;
  serverUrl?: string;
  debug?: boolean;
}

interface GoBridgeCommand {
  action: "join_room" | "leave_room";
  roomName?: string;
  token?: string;
  url?: string;
}

interface GoBridgeEvent {
  type: "connected" | "room_joined" | "room_left" | "disconnected" | "error";
  roomName?: string;
  participantId?: string;
  participantCount?: number;
  error?: string;
  state?: string;
}

/**
 * Manager for LiveKit Go Bridge connection
 * Handles publishing audio to LiveKit via external Go process
 */
export class LiveKitGoBridgeManager extends EventEmitter {
  private ws: WebSocket | null = null;
  private userId: string;
  private serverUrl: string;
  private isConnected = false;
  private audioQueue: Buffer[] = [];
  private debug: boolean;
  private publishCount = 0;

  constructor(config: GoBridgeConfig) {
    super();
    this.userId = config.userId;
    this.serverUrl = config.serverUrl || "ws://localhost:8080";
    this.debug = config.debug || false;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = `${this.serverUrl}/ws?userId=${encodeURIComponent(this.userId)}`;
      if (this.debug) {
        console.log(`[LiveKitGoBridge] Connecting to ${wsUrl}`);
      }

      this.ws = new WebSocket(wsUrl);

      const timeout = setTimeout(() => {
        reject(new Error("Connection timeout"));
        this.ws?.close();
      }, 5000);

      this.ws.on("open", () => {
        clearTimeout(timeout);
        this.isConnected = true;
        if (this.debug) {
          console.log("[LiveKitGoBridge] Connected");
        }

        // Process any queued audio
        this.flushAudioQueue();

        resolve();
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        if (data instanceof Buffer) {
          // Binary message - audio data from LiveKit (if subscribing)
          this.emit("audio", data);
        } else {
          // JSON message - control event
          try {
            const event = JSON.parse(data.toString()) as GoBridgeEvent;
            this.handleEvent(event);
          } catch (err) {
            console.error("[LiveKitGoBridge] Failed to parse message:", err);
          }
        }
      });

      this.ws.on("error", (err) => {
        clearTimeout(timeout);
        console.error("[LiveKitGoBridge] WebSocket error:", err);
        this.emit("error", err);
        if (!this.isConnected) {
          reject(err);
        }
      });

      this.ws.on(
        "close",
        (websocket: WebSocket, code: number, reason: string) => {
          this.isConnected = false;
          if (this.debug) {
            console.log(`[LiveKitGoBridge] Disconnected: ${code} ${reason}`);
          }
          this.emit("disconnected");
        },
      );
    });
  }

  private handleEvent(event: GoBridgeEvent) {
    if (this.debug) {
      console.log("[LiveKitGoBridge] Event:", event);
    }

    switch (event.type) {
      case "connected":
        this.emit("connected");
        break;
      case "room_joined":
        console.log(
          `[LiveKitGoBridge] Joined room ${event.roomName} as ${event.participantId}`,
        );
        this.emit("room_joined", {
          roomName: event.roomName,
          participantId: event.participantId,
          participantCount: event.participantCount,
        });
        break;
      case "room_left":
        console.log("[LiveKitGoBridge] Left room");
        this.emit("room_left");
        break;
      case "disconnected":
        this.emit("disconnected");
        break;
      case "error":
        console.error("[LiveKitGoBridge] Error:", event.error);
        this.emit("error", new Error(event.error || "Unknown error"));
        break;
    }
  }

  async joinRoom(roomName: string, token: string, url?: string): Promise<void> {
    if (!this.isConnected || !this.ws) {
      throw new Error("Not connected to Go bridge");
    }

    return new Promise((resolve, reject) => {
      const command: GoBridgeCommand = {
        action: "join_room",
        roomName,
        token,
        url,
      };

      // Listen for response
      const handleJoined = () => {
        this.off("room_joined", handleJoined);
        this.off("error", handleError);
        resolve();
      };

      const handleError = (err: Error) => {
        this.off("room_joined", handleJoined);
        this.off("error", handleError);
        reject(err);
      };

      this.once("room_joined", handleJoined);
      this.once("error", handleError);

      // Send command
      this.ws!.send(JSON.stringify(command));

      // Timeout after 10 seconds
      setTimeout(() => {
        this.off("room_joined", handleJoined);
        this.off("error", handleError);
        reject(new Error("Join room timeout"));
      }, 10000);
    });
  }

  async leaveRoom(): Promise<void> {
    if (!this.isConnected || !this.ws) {
      return;
    }

    const command: GoBridgeCommand = {
      action: "leave_room",
    };

    this.ws.send(JSON.stringify(command));
  }

  /**
   * Publish PCM audio data to LiveKit
   * @param audioData 16-bit PCM audio at 16kHz mono
   */
  publishAudio(audioData: Buffer): void {
    if (!this.isConnected || !this.ws) {
      // Queue audio if not connected
      this.audioQueue.push(audioData);

      // Limit queue size to prevent memory issues
      if (this.audioQueue.length > 100) {
        this.audioQueue.shift();
      }
      return;
    }

    // Send as binary frame - Go bridge expects raw PCM
    this.ws.send(audioData);
    this.publishCount++;
    if (this.debug && this.publishCount % 10 === 0) {
      // Compute simple energy metrics
      const sampleCount = Math.floor(audioData.length / 2);
      let sumAbs = 0;
      let sumSq = 0;
      let min = 32767;
      let max = -32768;
      for (let i = 0; i < sampleCount; i++) {
        const v = audioData.readInt16LE(i * 2);
        if (v < min) min = v;
        if (v > max) max = v;
        sumAbs += Math.abs(v);
        sumSq += v * v;
      }
      const meanAbs = sampleCount ? sumAbs / sampleCount : 0;
      const rms = sampleCount ? Math.sqrt(sumSq / sampleCount) : 0;
      console.log(
        `[LiveKitGoBridge] Sent audio chunk #${this.publishCount} (${audioData.length} bytes) energy meanAbs=${meanAbs.toFixed(1)} rms=${rms.toFixed(1)} min=${min} max=${max}`,
      );
    }
  }

  private flushAudioQueue(): void {
    if (!this.isConnected || !this.ws) {
      return;
    }

    while (this.audioQueue.length > 0) {
      const audio = this.audioQueue.shift();
      if (audio) {
        this.ws.send(audio);
      }
    }
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isConnected = false;
    this.audioQueue = [];
  }

  isReady(): boolean {
    return this.isConnected && this.ws?.readyState === WebSocket.OPEN;
  }
}
