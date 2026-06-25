/**
 * GalleryController — the always-on photo-library logic for this miniapp.
 *
 * Lives in the per-miniapp JSContext (NOT the WebView). Owns:
 *   - the library: `session.blob` (each photo a blob; the list IS the library)
 *   - capture: `session.camera.takePhoto()` → `session.blob.setFromUrl()` so
 *     the bytes land on disk host-side (never crossing the bridge)
 *   - favorites: a small id set in `session.storage`
 *   - durable display: the `gal:bytes` RPC reads a blob's bytes → base64 data
 *     URL (the WebView can't load a blob's file:// uri directly)
 */

import {bytesToBase64} from "@mentra/miniapp/background"
import type {
  BlobMeta,
  ButtonPressData,
  GlassesCapabilities,
  MiniappSession,
  UIModule,
} from "@mentra/miniapp/background"

import type {Channels} from "../../shared/channels"
import type {GallerySettings, GallerySnapshot, PhotoItem, Usage} from "../../shared/types"

const SETTINGS_KEY = "gallery:settings"
const FAVORITES_KEY = "gallery:favorites"
const DEFAULT_SETTINGS: GallerySettings = {saveToCameraRoll: true, photoSize: "medium"}
const EMPTY_USAGE: Usage = {bytes: 0, count: 0, quotaBytes: 0}
const CAPTURE_TIMEOUT_MS = 30_000

export class GalleryController {
  private started = false
  private readonly unsubs: Array<() => void> = []
  private ui!: UIModule<Channels>

  private capturing = false
  private settings: GallerySettings = {...DEFAULT_SETTINGS}
  private favorites = new Set<string>()
  private photos: PhotoItem[] = []
  private usage: Usage = EMPTY_USAGE

  /** id → fresh cloud URL (~30 min). Lost on restart; durable display uses bytes. */
  private readonly freshUrls = new Map<string, string>()

  constructor(private readonly session: MiniappSession) {}

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.ui = this.session.ui as unknown as UIModule<Channels>

    this.registerUiHandlers()
    await this.loadSettings()
    await this.loadFavorites()

    try {
      this.unsubs.push(
        this.session.input.onButtonPress((_d: ButtonPressData) => void this.capture()),
      )
    } catch {
      /* no input surface — the on-screen capture FAB still works */
    }

    await this.refreshLibrary()
    this.renderHud()
    console.log(`Gallery: started (${this.photos.length} photos, hasCamera=${this.hasCamera()})`)
  }

  // ── UI bus ─────────────────────────────────────────────────────────────

  private registerUiHandlers(): void {
    this.unsubs.push(this.ui.onOpen(() => this.sendSnapshot()))
    this.unsubs.push(this.ui.on("gal:request-snapshot", () => this.sendSnapshot()))
    this.unsubs.push(this.ui.on("gal:capture", () => void this.capture()))
    this.unsubs.push(this.ui.on("gal:delete", ({ids}) => void this.remove(ids)))
    this.unsubs.push(this.ui.on("gal:share", ({id}) => void this.share(id)))
    this.unsubs.push(this.ui.on("gal:favorite", ({id, favorite}) => void this.setFavorite(id, favorite)))
    this.unsubs.push(this.ui.on("gal:set-settings", (patch) => void this.updateSettings(patch)))
    this.unsubs.push(this.ui.on("gal:clear", () => void this.clearAll()))
    this.unsubs.push(this.ui.handle("gal:bytes", ({id}) => this.readBytes(id)))
  }

  private sendSnapshot(): void {
    const snap: GallerySnapshot = {
      photos: this.photos,
      settings: this.settings,
      usage: this.usage,
      capturing: this.capturing,
      hasCamera: this.hasCamera(),
    }
    this.ui.send("gal:snapshot", snap)
  }

  private hasCamera(): boolean {
    const cap = this.session.capabilities as (GlassesCapabilities & {hasCamera?: boolean}) | null
    return cap?.hasCamera !== false
  }

  // ── Capture ──────────────────────────────────────────────────────────────

  private async capture(): Promise<void> {
    if (this.capturing) return
    this.capturing = true
    this.ui.send("gal:status", {capturing: true})

    try {
      const res = await withTimeout(
        this.session.camera.takePhoto({
          size: this.settings.photoSize,
          compress: "none",
          sound: true,
          saveToGallery: this.settings.saveToCameraRoll,
        }),
        CAPTURE_TIMEOUT_MS,
        "Capture",
      )

      const id = makeKey()
      try {
        await this.session.blob.setFromUrl(id, res.photoUrl, {
          mimeType: res.mimeType || "image/jpeg",
          name: makeName(res.mimeType),
          meta: {createdAt: Date.now(), resolution: this.settings.photoSize},
        })
      } catch (err) {
        console.log("Gallery: blob.setFromUrl failed", err)
      }
      this.freshUrls.set(id, res.photoUrl)

      await this.refreshLibrary()
      this.capturing = false
      this.ui.send("gal:status", {capturing: false, savedId: id})
    } catch (err) {
      this.capturing = false
      this.ui.send("gal:status", {capturing: false, error: humanizeError(err)})
      console.log("Gallery: takePhoto failed", err)
    }
  }

  private async readBytes(id: string): Promise<{dataUrl: string | null}> {
    try {
      const bytes = await this.session.blob.bytes(id)
      if (!bytes || bytes.length === 0) return {dataUrl: null}
      let meta: BlobMeta | null = null
      try {
        meta = await this.session.blob.get(id)
      } catch {
        meta = null
      }
      const mime = meta?.mimeType || "image/jpeg"
      return {dataUrl: `data:${mime};base64,${bytesToBase64(bytes)}`}
    } catch (err) {
      console.log("Gallery: readBytes failed", err)
      return {dataUrl: null}
    }
  }

  // ── Library ──────────────────────────────────────────────────────────────

  private async refreshLibrary(): Promise<void> {
    try {
      const [blobs, usage] = await Promise.all([this.session.blob.list(), this.session.blob.usage()])
      this.photos = blobs.map((b) => this.toItem(b)).sort((a, b) => b.createdAt - a.createdAt)
      this.usage = usage
    } catch (err) {
      console.log("Gallery: list failed", err)
    }
    this.ui.send("gal:photos", {photos: this.photos, usage: this.usage})
  }

  private toItem(m: BlobMeta): PhotoItem {
    const duration = Number(m.meta?.durationMs ?? 0)
    return {
      id: m.key,
      createdAt: Number(m.meta?.createdAt ?? m.createdAt),
      mimeType: m.mimeType,
      bytes: m.bytes,
      durationMs: m.mimeType?.startsWith("video/") || duration > 0 ? duration : undefined,
      favorite: this.favorites.has(m.key),
      url: this.freshUrls.get(m.key),
    }
  }

  private async remove(ids: string[]): Promise<void> {
    let changed = false
    for (const id of ids) {
      try {
        await this.session.blob.delete(id)
        this.freshUrls.delete(id)
        if (this.favorites.delete(id)) changed = true
      } catch (err) {
        console.log("Gallery: delete failed", err)
      }
    }
    if (changed) await this.saveFavorites()
    await this.refreshLibrary()
  }

  private async share(id: string): Promise<void> {
    try {
      await this.session.blob.share(id)
    } catch (err) {
      console.log("Gallery: share failed", err)
    }
  }

  private async clearAll(): Promise<void> {
    try {
      await this.session.blob.clear()
    } catch (err) {
      console.log("Gallery: clear failed", err)
    }
    this.freshUrls.clear()
    this.favorites.clear()
    await this.saveFavorites()
    await this.refreshLibrary()
  }

  // ── Favorites ──────────────────────────────────────────────────────────────

  private async setFavorite(id: string, favorite: boolean): Promise<void> {
    if (favorite) this.favorites.add(id)
    else this.favorites.delete(id)
    await this.saveFavorites()
    await this.refreshLibrary()
  }

  private async loadFavorites(): Promise<void> {
    try {
      const raw = await this.session.storage.get(FAVORITES_KEY)
      if (raw) {
        const arr = JSON.parse(raw) as string[]
        if (Array.isArray(arr)) this.favorites = new Set(arr)
      }
    } catch {
      /* ignore */
    }
  }

  private async saveFavorites(): Promise<void> {
    try {
      await this.session.storage.set(FAVORITES_KEY, JSON.stringify([...this.favorites]))
    } catch (err) {
      console.log("Gallery: save favorites failed", err)
    }
  }

  // ── Settings ─────────────────────────────────────────────────────────────

  private async loadSettings(): Promise<void> {
    try {
      const raw = await this.session.storage.get(SETTINGS_KEY)
      if (raw) this.settings = {...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<GallerySettings>)}
    } catch {
      /* keep defaults */
    }
  }

  private async updateSettings(patch: Partial<GallerySettings>): Promise<void> {
    this.settings = {...this.settings, ...patch}
    this.sendSnapshot()
    try {
      await this.session.storage.set(SETTINGS_KEY, JSON.stringify(this.settings))
    } catch (err) {
      console.log("Gallery: save settings failed", err)
    }
  }

  private renderHud(): void {
    try {
      this.session.display.showTextWall(`Gallery · ${this.photos.length} photos`, {view: "main"})
    } catch {
      /* no display attached — fine */
    }
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function makeKey(): string {
  return `photo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function makeName(mimeType?: string): string {
  const ext = mimeType?.includes("png") ? "png" : mimeType?.includes("webp") ? "webp" : "jpg"
  const d = new Date()
  const p = (n: number) => n.toString().padStart(2, "0")
  return `photo-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(
    d.getSeconds(),
  )}.${ext}`
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

function humanizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? "")
  const lower = message.toLowerCase()
  if (lower.includes("permission")) return "Camera permission is required."
  if (lower.includes("no camera") || lower.includes("camera not")) return "These glasses have no camera."
  if (lower.includes("not connected") || lower.includes("disconnected")) return "Glasses not connected."
  if (lower.includes("timed out") || lower.includes("timeout")) return "Capture timed out. Try again."
  return message ? `Couldn't capture: ${message}` : "Couldn't capture photo."
}
