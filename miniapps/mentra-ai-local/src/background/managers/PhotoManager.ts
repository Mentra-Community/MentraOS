/**
 * PhotoManager — camera capture + recent-photo context.
 *
 * PORT NOTE: the cloud SDK's requestPhoto() returned raw bytes (a Buffer). The
 * local SDK's takePhoto() returns a short-lived signed `photoUrl` instead, so
 * we fetch the bytes here and keep them as a base64 data URL — the form both
 * Gemini (agent image content) and the webview thumbnail consume.
 *
 * Keeps the current photo plus N previous (PHOTO_SETTINGS.previousPhotosToKeep)
 * so follow-up visual questions have context.
 */

import type {MiniappSession} from "@mentra/miniapp/background"
import {PHOTO_SETTINGS} from "../constants/config"

export interface StoredPhoto {
  requestId: string
  /** "data:<mime>;base64,…" — ready for agent image content and UI rendering. */
  dataUrl: string
  mimeType: string
  size: number
  timestamp: number
}

export class PhotoManager {
  private currentPhoto: StoredPhoto | null = null
  private previousPhotos: StoredPhoto[] = []

  constructor(private readonly session: MiniappSession) {}

  private get hasCamera(): boolean {
    return Boolean(this.session.capabilities?.hasCamera)
  }

  /**
   * Capture a photo and store it as the current photo (rotating the prior
   * current into the previous list). Returns null on failure or no camera.
   */
  async takePhoto(): Promise<StoredPhoto | null> {
    if (!this.hasCamera) return null

    try {
      const photo = await this.session.camera.takePhoto({sound: false})
      const dataUrl = await this.fetchAsDataUrl(photo.photoUrl, photo.mimeType)
      if (!dataUrl) return null

      const stored: StoredPhoto = {
        requestId: photo.requestId,
        dataUrl,
        mimeType: photo.mimeType,
        size: photo.size,
        timestamp: Date.now(),
      }

      this.rotatePhotos(stored)
      return stored
    } catch (error) {
      console.error("Failed to capture photo:", error)
      return null
    }
  }

  /**
   * Photos for the agent, current-first: [current, ...previous]. Data URLs.
   */
  getPhotosForContext(): string[] {
    const photos: string[] = []
    if (this.currentPhoto) photos.push(this.currentPhoto.dataUrl)
    for (const p of this.previousPhotos) photos.push(p.dataUrl)
    return photos
  }

  getCurrentPhoto(): StoredPhoto | null {
    return this.currentPhoto
  }

  clear(): void {
    this.currentPhoto = null
    this.previousPhotos = []
  }

  destroy(): void {
    this.clear()
  }

  /** Current → previous, new → current; cap previous at the configured count. */
  private rotatePhotos(next: StoredPhoto): void {
    if (this.currentPhoto) {
      this.previousPhotos.unshift(this.currentPhoto)
      if (this.previousPhotos.length > PHOTO_SETTINGS.previousPhotosToKeep) {
        this.previousPhotos = this.previousPhotos.slice(0, PHOTO_SETTINGS.previousPhotosToKeep)
      }
    }
    this.currentPhoto = next
  }

  /** Fetch the signed photo URL and encode as a base64 data URL. */
  private async fetchAsDataUrl(url: string, mimeType: string): Promise<string | null> {
    try {
      const res = await fetch(url)
      if (!res.ok) {
        console.warn(`Photo fetch HTTP ${res.status}`)
        return null
      }
      const bytes = new Uint8Array(await res.arrayBuffer())
      const base64 = base64FromBytes(bytes)
      return `data:${mimeType || "image/jpeg"};base64,${base64}`
    } catch (error) {
      console.warn("Photo fetch failed:", error)
      return null
    }
  }
}

/** Base64-encode bytes without Node's Buffer (unavailable in the JSContext). */
function base64FromBytes(bytes: Uint8Array): string {
  let binary = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  // `btoa` is provided by the browser-target runtime the bundle is built for.
  return btoa(binary)
}
