import {MiniappRequestType} from "../protocol"
import {MiniappSession} from "../session"

export enum CanvasOperation {
  SHOW_TEXT = "show_text",
  SHOW_BITMAP = "show_bitmap",
  CLEAR = "clear",
  SHOW_PAGE = "show_page",
}

/** Fields available on every canvas operation. */
export interface BaseOptions {
  page_id?: string
}

/** Position and size of a view's container on the canvas. */
export interface Box {
  x?: number
  y?: number
  width?: number
  height?: number
}

export interface TextOptions extends Box, BaseOptions {
  borderWidth?: number
  borderRadius?: number
}

export type BitmapOptions = Box & BaseOptions
export type ClearOptions = BaseOptions

// Required + optional fields, keyed by operation. This is the wire shape.
// page_id rides along on every entry via the shared BaseOptions.
interface CanvasPayloads {
  [CanvasOperation.SHOW_TEXT]: TextOptions & {text: string}
  [CanvasOperation.SHOW_BITMAP]: BitmapOptions & {data: string}
  [CanvasOperation.SHOW_PAGE]: BaseOptions & {id: string}
  [CanvasOperation.CLEAR]: ClearOptions
}

export class CanvasManager {
  constructor(private readonly session: MiniappSession) {}

  private send<Op extends CanvasOperation>(operation: Op, options: CanvasPayloads[Op]): void {
    this.session.sendOneShot({
      type: MiniappRequestType.CANVAS,
      operation,
      options,
    })
  }

  /** Show a single block of text filling the glasses display. */
  showText(text: string, options: TextOptions = {}): void {
    this.send(CanvasOperation.SHOW_TEXT, {text, ...options})
  }

  /**
   * Show a bitmap. Phone SGC handles conversion to glasses-native format.
   * Optional `x`/`y`/`width`/`height` position and size the container; omit for default placement.
   */
  showBitmap(data: string, options: BitmapOptions = {}): void {
    this.send(CanvasOperation.SHOW_BITMAP, {data, ...options})
  }

  showPage(id: string, options: BaseOptions = {}): void {
    this.send(CanvasOperation.SHOW_PAGE, {id, ...options})
  }

  clear(options: ClearOptions = {}): void {
    this.send(CanvasOperation.CLEAR, options)
  }
}