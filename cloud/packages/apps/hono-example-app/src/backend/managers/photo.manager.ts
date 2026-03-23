import type { UserSession } from "../UserSession"

export interface StoredPhoto {
  requestId: string
  buffer: Buffer
  timestamp: Date
  userId: string
  mimeType: string
  filename: string
  size: number
}

interface SSEWriter {
  write: (data: string) => void
  userId: string
  close: () => void
}

/**
 * PhotoManager — captures, stores, and broadcasts photos for a single user.
 */
export class PhotoManager {
  private photos: Map<string, StoredPhoto> = new Map()
  private sseClients: Set<SSEWriter> = new Set()

  constructor(private userSession: UserSession) {}

  /** Capture a photo from the glasses and store + broadcast it */
  async takePhoto(): Promise<void> {
    const session = this.userSession.appSession
    if (!session) throw new Error("No active glasses session")

    const photo = await session.camera.requestPhoto()

    const stored: StoredPhoto = {
      requestId: photo.requestId,
      buffer: photo.buffer,
      timestamp: photo.timestamp,
      userId: this.userSession.userId,
      mimeType: photo.mimeType,
      filename: photo.filename,
      size: photo.size,
    }

    this.photos.set(photo.requestId, stored)
    this.broadcastPhoto(stored)
  }

  /** Push a photo to all connected SSE clients */
  broadcastPhoto(photo: StoredPhoto): void {
    const base64Data = photo.buffer.toString("base64")
    const payload = JSON.stringify({
      requestId: photo.requestId,
      timestamp: photo.timestamp.getTime(),
      mimeType: photo.mimeType,
      filename: photo.filename,
      size: photo.size,
      userId: photo.userId,
      base64: base64Data,
      dataUrl: `data:${photo.mimeType};base64,${base64Data}`,
    })

    for (const client of this.sseClients) {
      try {
        client.write(payload)
      } catch {
        this.sseClients.delete(client)
      }
    }
  }

  getPhoto(requestId: string): StoredPhoto | undefined {
    return this.photos.get(requestId)
  }

  /** All photos for this user, sorted newest-first */
  getAll(): StoredPhoto[] {
    return Array.from(this.photos.values()).sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
    )
  }

  /** The full photos map (used by SSE to send history on connect) */
  getAllMap(): Map<string, StoredPhoto> {
    return this.photos
  }

  removeAll(): void {
    this.photos.clear()
  }

  addSSEClient(client: SSEWriter): void {
    this.sseClients.add(client)
  }

  removeSSEClient(client: SSEWriter): void {
    this.sseClients.delete(client)
  }

  /** Tear down — clear photos and SSE clients */
  destroy(): void {
    this.photos.clear()
    this.sseClients.clear()
  }
}
