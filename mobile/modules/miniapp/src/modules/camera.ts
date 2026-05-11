/**
 * @fileoverview CameraModule — glasses camera control and photo capture.
 */

import {MiniappRequestType} from "../protocol"
import {MiniappSession} from "../session"

export interface SetCameraFovOptions {
  /** Horizontal FOV, degrees. */
  horizontal?: number
  /** Vertical FOV, degrees. */
  vertical?: number
}

export interface TakePhotoOptions {
  size?: "small" | "medium" | "large"
  compress?: "none" | "low" | "medium" | "high"
  sound?: boolean
  saveToGallery?: boolean
}

export interface PhotoTaken {
  photoUrl: string
  mimeType: string
  size: number
}

export class CameraModule {
  constructor(private readonly session: MiniappSession) {}

  /** True iff `CAMERA` is declared in the miniapp's manifest. */
  get hasPermission(): boolean {
    return this.session._hasManifestPermission("CAMERA")
  }

  /** Write camera FOV settings. */
  setFov(options: SetCameraFovOptions): void {
    this.session.sendOneShot({
      type: MiniappRequestType.CAMERA_FOV,
      horizontal: options.horizontal,
      vertical: options.vertical,
    })
  }

  /**
   * Take a photo via the glasses camera. Returns a URL to the captured image.
   * Requires CAMERA permission declared in miniapp.json.
   *
   * The photo is uploaded to cloud storage (24h TTL) and the URL is returned.
   * If the glasses don't have a camera, the phone-side handler rejects with
   * an error. Check `session.capabilities.hasCamera` before calling.
   */
  async takePhoto(options: TakePhotoOptions = {}): Promise<PhotoTaken> {
    return this.session.sendRequest<PhotoTaken>({
      type: MiniappRequestType.PHOTO,
      size: options.size ?? "medium",
      compress: options.compress ?? "none",
      sound: options.sound ?? true,
      saveToGallery: options.saveToGallery ?? false,
    })
  }
}
