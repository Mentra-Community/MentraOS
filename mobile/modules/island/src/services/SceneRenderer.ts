/**
 * SceneRenderer — the device-aware boundary of the scene display pipeline.
 *
 * LocalDisplayManager owns WHO may draw (arbitration/boot/expiry); this service
 * owns WHAT gets sent for a scene: capabilities lookup, legacy-layout→scene
 * conversion (sugar and old bundles ride the same pipeline), process → diff →
 * SceneFrame emission, retained-scene replay, and the degrade branch for
 * devices that can't position elements.
 *
 * Everything device-specific here is DATA (capability fields, display profile);
 * the code paths are generic. Spec: notes/miniapp-display-render-implementation-spec.md
 */

import displayProcessor from "./DisplayProcessor"
import {getRuntimeHooks, ISLAND_SETTINGS_KEYS} from "../runtime/config"
import {DeviceTypes, getModelCapabilities} from "../types"
import {
  degradeScene,
  diffScene,
  processScene,
  SceneStore,
  type FrameElement,
  type SceneBreakMode,
  type SceneDisplayCapabilities,
  type SceneElementInput,
  type SceneFrame,
} from "../utils/display/scene"

const LOG_TAG = "SCENE_RENDERER"

/** Legacy layout shape (matches DisplayPayload.layout). */
export type LegacyLayout = {layoutType: string; [key: string]: unknown}

export type SceneEmitResult =
  /** A SceneFrame went to native. */
  | {kind: "scene"; degraded: boolean; dropped: string[]}
  /** Degrade path: caller routes this legacy layout through the existing pipeline (null layout ⇒ clear). */
  | {kind: "legacy"; layout: LegacyLayout | null; degraded: boolean; dropped: string[]}
  /** No display capabilities on the connected device. */
  | {kind: "no-display"}

class SceneRenderer {
  private static instance: SceneRenderer | null = null
  private store = new SceneStore()

  public static getInstance(): SceneRenderer {
    if (!SceneRenderer.instance) {
      SceneRenderer.instance = new SceneRenderer()
    }
    return SceneRenderer.instance
  }

  // ===========================================================================
  // Capabilities
  // ===========================================================================

  /**
   * Scene capabilities of the currently-selected device, or null when it has no
   * display block. Read on demand — same model source the CONNECT_ACK uses.
   */
  public currentCapabilities(): SceneDisplayCapabilities | null {
    const hooks = getRuntimeHooks()
    const model =
      (hooks.settings?.getSetting(ISLAND_SETTINGS_KEYS.defaultWearable) as string | undefined) ??
      (hooks.glassesStatus?.get()?.deviceModel as string | undefined)
    const display = getModelCapabilities((model ?? DeviceTypes.NONE) as DeviceTypes)?.display
    if (!display) return null
    return {
      width: display.width ?? display.resolution?.width ?? displayProcessor.getProfile().displayWidthPx,
      height: display.height ?? display.resolution?.height ?? displayProcessor.getProfile().displayHeightPx ?? 288,
      canPosition: display.canPosition === true,
      maxTextElements: display.maxTextElements ?? 6,
      maxImageElements: display.maxImageElements ?? 0,
      maxImagePx: display.maxImagePx,
      shapes: display.shapes ?? [],
      intensityLevels: display.intensityLevels ?? 2,
      partialUpdate: display.partialUpdate ?? false,
    }
  }

  // ===========================================================================
  // Legacy layout → scene conversion (sugar + old bundles on the scene path)
  // ===========================================================================

  /**
   * Convert a legacy layout into scene elements for a positioning device.
   * Returns null for layouts that must stay on the legacy path (dashboard_card,
   * clear_view, unknown types). Sugar semantics: full-canvas / split boxes.
   */
  public convertLegacyLayout(layout: LegacyLayout, caps: SceneDisplayCapabilities): SceneElementInput[] | null {
    const W = caps.width
    const H = caps.height
    const breakMode = layout.breakMode as SceneBreakMode | undefined

    switch (layout.layoutType) {
      case "text_wall":
        return [
          {
            type: "text",
            id: "sugar:wall",
            box: {x: 0, y: 0, w: W, h: H},
            text: String(layout.text ?? ""),
            ...(breakMode ? {style: {breakMode}} : {}),
          },
        ]
      case "double_text_wall": {
        const half = Math.floor(W / 2)
        return [
          {
            type: "text",
            id: "sugar:left",
            box: {x: 0, y: 0, w: half, h: H},
            text: String(layout.topText ?? ""),
            ...(breakMode ? {style: {breakMode}} : {}),
          },
          {
            type: "text",
            id: "sugar:right",
            box: {x: half, y: 0, w: W - half, h: H},
            text: String(layout.bottomText ?? ""),
            ...(breakMode ? {style: {breakMode}} : {}),
          },
        ]
      }
      case "reference_card": {
        const titleH = Math.max(24, Math.floor(H / 5))
        return [
          {type: "text", id: "sugar:title", box: {x: 0, y: 0, w: W, h: titleH}, text: String(layout.title ?? "")},
          {
            type: "text",
            id: "sugar:body",
            box: {x: 0, y: titleH, w: W, h: H - titleH},
            text: String(layout.text ?? ""),
            ...(breakMode ? {style: {breakMode}} : {}),
          },
        ]
      }
      case "bitmap_view": {
        // Dimensionless legacy bitmaps historically landed in the device's
        // default ~200×100 container (G2 seeded 200×100 at 188,44) — NOT the
        // full canvas, which would tile a small image across the whole frame.
        const w = (layout.width as number | undefined) ?? Math.min(200, W)
        const h = (layout.height as number | undefined) ?? Math.min(100, H)
        return [
          {
            type: "image",
            id: "sugar:bmp",
            box: {
              x: (layout.x as number | undefined) ?? Math.max(0, Math.round((W - w) / 2)),
              y: (layout.y as number | undefined) ?? Math.max(0, Math.round((H - h) / 4)),
              w,
              h,
            },
            data: String(layout.data ?? ""),
          },
        ]
      }
      case "positioned_text": {
        const border = (layout.borderWidth as number | undefined) ?? 0
        const radius = (layout.borderRadius as number | undefined) ?? 0
        return [
          {
            type: "text",
            id: "sugar:pos",
            box: {
              x: (layout.x as number | undefined) ?? 0,
              y: (layout.y as number | undefined) ?? 0,
              w: (layout.width as number | undefined) ?? W,
              h: (layout.height as number | undefined) ?? H,
            },
            text: String(layout.text ?? ""),
            ...(border || radius ? {style: {border, radius}} : {}),
          },
        ]
      }
      default:
        return null
    }
  }

  // ===========================================================================
  // Emit
  // ===========================================================================

  /**
   * Process + diff + send a scene for (app, view). On non-positioning devices
   * this returns the degraded legacy layout instead — the caller routes it
   * through the existing DisplayProcessor path (which wraps it, keeping G1/Z100
   * output byte-identical to today).
   */
  public emitScene(appId: string, view: "main" | "dashboard", elements: SceneElementInput[]): SceneEmitResult {
    const caps = this.currentCapabilities()
    if (!caps) return {kind: "no-display"}

    if (!caps.canPosition) {
      const {layout, degraded, dropped} = degradeScene(elements)
      return {kind: "legacy", layout, degraded, dropped}
    }

    const processed = processScene(elements, caps, displayProcessor.getProfile())
    const {elements: diffed, removed} = diffScene(
      this.store.lastFrame(appId, view),
      processed.elements,
      this.store.nextSyntheticId(appId, view),
    )
    this.store.commit(appId, view, diffed)

    const frame: SceneFrame = {
      appId,
      view,
      sceneEpoch: this.store.currentEpoch(appId, view),
      elements: diffed,
      removed,
    }
    this.sendFrame(frame)
    return {kind: "scene", degraded: processed.degraded, dropped: processed.dropped}
  }

  /**
   * Re-emit an app's retained scene (reconnect / arbitration restore). Replay
   * is always create-based — the device rebuilds from scratch (spec §4).
   * Returns false when nothing is retained.
   */
  public replayApp(appId: string, view: "main" | "dashboard"): boolean {
    const frame = this.store.buildReplayFrame(appId, view)
    if (!frame) return false
    this.sendFrame(frame)
    return true
  }

  /** Forget an app's retained scenes (app stop). */
  public clearApp(appId: string): void {
    this.store.clear(appId)
  }

  /**
   * Reset the diff baseline for (app, view) without touching the device.
   * Used when a legacy layout bypasses the scene path (clear_view /
   * dashboard_card / unknown layoutTypes go to native raw): after that, the
   * retained frame no longer matches the glasses, so the next render() must
   * diff from empty — otherwise "unchanged" elements would be skipped and
   * never repainted.
   */
  public resetBaseline(appId: string, view: "main" | "dashboard"): void {
    this.store.commit(appId, view, [])
  }

  private sendFrame(frame: SceneFrame): void {
    try {
      const sendDisplayEvent = getRuntimeHooks().sendDisplayEvent
      if (sendDisplayEvent) {
        void Promise.resolve(sendDisplayEvent({view: frame.view, scene: frame})).catch((err) => {
          console.error(`${LOG_TAG}: native scene send failed:`, err)
        })
      }
    } catch (err) {
      console.error(`${LOG_TAG}: native scene send failed:`, err)
    }
  }

  // ===========================================================================
  // Test hooks
  // ===========================================================================

  public _resetForTest(): void {
    this.store.clearAll()
  }

  public _lastFrameForTest(appId: string, view: string): FrameElement[] {
    return this.store.lastFrame(appId, view)
  }
}

const sceneRenderer = SceneRenderer.getInstance()
export default sceneRenderer
export {SceneRenderer}
