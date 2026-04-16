import { EventBus } from "../EventBus";
import {
  DEFAULT_GLASSES_INFO,
  type GlassesInfo,
  type Glasses,
  type DisplayEvent,
  type ButtonEvent,
  type TouchEvent,
} from "../types";

export class GlassesManager {
  private bus = new EventBus();
  private _info: GlassesInfo = { ...DEFAULT_GLASSES_INFO };
  private attachedGlasses: Glasses | null = null;
  private cleanups: Array<() => void> = [];

  // ── State (reactive) ──────────────────────────────────────

  get info(): GlassesInfo {
    return { ...this._info };
  }
  get connected(): boolean {
    return this._info.connected;
  }
  get model(): string | null {
    return this._info.model;
  }
  get capabilities() {
    return this._info.capabilities;
  }
  get batteryLevel(): number | null {
    return this._info.batteryLevel;
  }
  get charging(): boolean {
    return this._info.charging;
  }
  get micEnabled(): boolean {
    return this._info.micEnabled;
  }
  get firmwareVersion(): string | null {
    return this._info.firmwareVersion;
  }

  // ── Attach/Detach ─────────────────────────────────────────

  /**
   * Attach a glasses instance — auto-wires ALL events bidirectionally.
   *
   * Upstream (glasses → cloud):
   *   mic chunks → client.audio.send()
   *   button presses → cloud
   *   touch events → cloud
   *   battery updates → cloud
   *
   * Downstream (cloud/apps → glasses):
   *   display events → glasses.display
   *   LED commands → glasses.led
   *   photo requests → glasses.camera → response back to cloud
   */
  attach(glasses: Glasses): void {
    // Detach previous if any
    this.detach();
    this.attachedGlasses = glasses;

    // Update info from the glasses
    this._info = {
      connected: true,
      model: glasses.model,
      capabilities: { ...glasses.capabilities },
      batteryLevel: glasses.device.batteryLevel,
      charging: glasses.device.charging,
      micEnabled: false,
      firmwareVersion: glasses.device.firmwareVersion,
      serialNumber: null,
    };

    // Wire upstream: glasses → client events
    this.cleanups.push(
      glasses.device.onButtonPress((e) => this.bus.emit("button", e)),
      glasses.device.onTouch((e) => this.bus.emit("touch", e)),
      glasses.device.onBatteryUpdate((level, charging) => {
        this._info.batteryLevel = level;
        this._info.charging = charging;
        this.bus.emit("changed", this.info);
      }),
      glasses.mic.onChunk((pcm) => this.bus.emit("mic_data", pcm))
    );

    this.bus.emit("changed", this.info);
    console.log(`[GlassesManager] Attached: ${glasses.model}`);
  }

  detach(): void {
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];

    if (this.attachedGlasses) {
      this._info = { ...DEFAULT_GLASSES_INFO };
      this.attachedGlasses = null;
      this.bus.emit("changed", this.info);
    }
  }

  // ── Report state manually (for when not using attach) ─────

  setInfo(partial: Partial<GlassesInfo>): void {
    Object.assign(this._info, partial);
    this.bus.emit("changed", this.info);
  }

  setDisconnected(): void {
    this._info.connected = false;
    this.bus.emit("changed", this.info);
  }

  // ── Forward hardware events to cloud ──────────────────────

  sendButtonEvent(event: ButtonEvent): void {
    this.bus.emit("button", event);
  }

  sendTouchEvent(event: TouchEvent): void {
    this.bus.emit("touch", event);
  }

  // ── Route cloud commands to attached glasses ──────────────

  /** Called internally when a display event arrives from the cloud/app */
  handleDisplayEvent(event: DisplayEvent): void {
    if (
      this.attachedGlasses &&
      this.attachedGlasses.capabilities.hasDisplay
    ) {
      // Route to the glasses display
      const payload = event.payload;
      switch (event.type) {
        case "text_wall":
          this.attachedGlasses.display.showTextWall(payload.text as string);
          break;
        case "clear":
          this.attachedGlasses.display.clear();
          break;
        default:
          this.attachedGlasses.display.showText(
            (payload.text as string) || ""
          );
      }
    }
    // Also emit so the app can listen
    this.bus.emit("display", event);
  }

  handleLedCommand(cmd: {
    on: boolean;
    color?: string;
    durationMs?: number;
  }): void {
    if (
      this.attachedGlasses &&
      this.attachedGlasses.capabilities.hasLight
    ) {
      if (cmd.on) {
        this.attachedGlasses.led.set({
          color: cmd.color || "#FFFFFF",
          durationMs: cmd.durationMs,
        });
      } else {
        this.attachedGlasses.led.off();
      }
    }
    this.bus.emit("led", cmd);
  }

  async handlePhotoRequest(request: {
    requestId: string;
    packageName: string;
  }): Promise<{
    data: Uint8Array;
    mimeType: string;
    width: number;
    height: number;
  } | null> {
    if (
      !this.attachedGlasses ||
      !this.attachedGlasses.capabilities.hasCamera
    )
      return null;
    const result = await this.attachedGlasses.camera.takePhoto();
    this.bus.emit("photo_request", request);
    return result;
  }

  // ── Events ────────────────────────────────────────────────

  on(
    event: "changed",
    handler: (info: GlassesInfo) => void
  ): () => void;
  on(
    event: "display",
    handler: (event: DisplayEvent) => void
  ): () => void;
  on(
    event: "led",
    handler: (cmd: { on: boolean; color?: string; durationMs?: number }) => void
  ): () => void;
  on(
    event: "photo_request",
    handler: (req: { requestId: string; packageName: string }) => void
  ): () => void;
  on(
    event: "button",
    handler: (event: ButtonEvent) => void
  ): () => void;
  on(
    event: "touch",
    handler: (event: TouchEvent) => void
  ): () => void;
  on(
    event: "mic_data",
    handler: (pcm: Uint8Array) => void
  ): () => void;
  on(event: string, handler: (...args: any[]) => void): () => void {
    return this.bus.on(event, handler);
  }

  destroy(): void {
    this.detach();
    this.bus.removeAll();
  }
}
