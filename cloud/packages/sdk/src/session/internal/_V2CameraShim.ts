import type { PhotoData as LegacyPhotoData } from "../../types/photo-data";
import { AppToCloudMessageType } from "../../types";
import type { MentraSession } from "../MentraSession";
import type {
  ExistingStreamInfo,
  ManagedStreamOptions,
  ManagedStreamResult,
  PhotoOptions,
  RtmpStreamOptions,
} from "../managers/CameraManager";

export interface _V2PhotoRequestOptions {
  saveToGallery?: boolean;
  customWebhookUrl?: string;
  authToken?: string;
  size?: "small" | "medium" | "large" | "full";
  compress?: "none" | "medium" | "heavy";
  sound?: boolean;
}

export interface _V2PhotoRequestBridge {
  registerPhotoRequest(
    requestId: string,
    request: {
      userId: string;
      sessionId: string;
      session: unknown;
      resolve: (photo: LegacyPhotoData) => void;
      reject: (error: Error) => void;
      timestamp: number;
    },
  ): void;
  completePhotoRequest(requestId: string):
    | {
        resolve: (photo: LegacyPhotoData) => void;
        reject: (error: Error) => void;
      }
    | undefined;
}

interface _V2CameraShimConfig {
  photoRequestBridge?: _V2PhotoRequestBridge;
  getV2Session?: () => unknown;
}

function generateRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `photo_req_${crypto.randomUUID()}`;
  }

  return `photo_req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

export class _V2CameraShim {
  private readonly session: MentraSession;
  private readonly config: _V2CameraShimConfig;

  constructor(session: MentraSession, config: _V2CameraShimConfig = {}) {
    this.session = session;
    this.config = config;
  }

  get hasPermission(): boolean {
    return this.session.camera.hasPermission;
  }

  takePhoto(options?: PhotoOptions) {
    return this.session.camera.takePhoto(options);
  }

  onPhotoTaken(handler: (photo: any) => void): () => void {
    return this.session.camera.onPhotoTaken(handler);
  }

  async requestPhoto(options?: _V2PhotoRequestOptions): Promise<LegacyPhotoData> {
    const bridge = this.config.photoRequestBridge;
    const userId = this.session.userId;

    if (!bridge || !userId) {
      throw new Error("requestPhoto() requires the MiniAppServer photo upload bridge");
    }

    return new Promise<LegacyPhotoData>((resolve, reject) => {
      const requestId = generateRequestId();

      bridge.registerPhotoRequest(requestId, {
        userId,
        sessionId: this.session.sessionId,
        session: this.config.getV2Session?.() ?? this.session,
        resolve,
        reject,
        timestamp: Date.now(),
      });

      this.session.sendMessage({
        type: AppToCloudMessageType.PHOTO_REQUEST,
        packageName: this.session.packageName,
        sessionId: this.session.sessionId,
        requestId,
        timestamp: new Date(),
        saveToGallery: options?.saveToGallery ?? false,
        customWebhookUrl: options?.customWebhookUrl,
        authToken: options?.authToken,
        size: options?.size ?? "medium",
        compress: options?.compress ?? "none",
        sound: options?.sound,
      });

      if (options?.customWebhookUrl) {
        const pending = bridge.completePhotoRequest(requestId);
        pending?.resolve({
          buffer: Buffer.from([]),
          mimeType: "image/jpeg",
          filename: "photo.jpg",
          requestId,
          size: 0,
          timestamp: new Date(),
        });
      }
    });
  }

  startStream(options: RtmpStreamOptions): Promise<void> {
    return this.session.camera.startDirectStream(options);
  }

  stopStream(): Promise<void> {
    return this.session.camera.stopStream();
  }

  onStreamStatus(handler: (status: any) => void): () => void {
    return this.session.camera.onStreamStatus(handler);
  }

  isCurrentlyStreaming(): boolean {
    return this.session.camera.isCurrentlyStreaming();
  }

  getCurrentStreamUrl(): string | undefined {
    return this.session.camera.getCurrentStreamUrl();
  }

  getStreamStatus() {
    return this.session.camera.getStreamStatus();
  }

  startManagedStream(options?: ManagedStreamOptions): Promise<ManagedStreamResult> {
    return this.session.camera.startManagedStream(options);
  }

  stopManagedStream(): Promise<void> {
    return this.session.camera.stopManagedStream();
  }

  onManagedStreamStatus(handler: (status: any) => void): () => void {
    return this.session.camera.onManagedStreamStatus(handler);
  }

  isManagedStreamActive(): boolean {
    return this.session.camera.isManagedStreamActive();
  }

  getManagedStreamUrls(): ManagedStreamResult | undefined {
    return this.session.camera.getManagedStreamUrls();
  }

  checkExistingStream(): Promise<ExistingStreamInfo> {
    return this.session.camera.checkExistingStream();
  }
}
