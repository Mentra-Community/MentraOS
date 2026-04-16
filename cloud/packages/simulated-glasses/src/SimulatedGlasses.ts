import {
  EventBus,
  MentraCapabilityError,
  type Glasses,
  type GlassesCapabilities,
  type GlassesDisplayManager,
  type GlassesCameraManager,
  type GlassesMicManager,
  type GlassesLedManager,
  type GlassesDeviceManager,
  type ButtonEvent,
  type TouchEvent as MentraTouchEvent,
  type DisplayEvent,
} from "@mentra/client";
import { PROFILES, type DeviceProfile } from "./profiles";

// ── Simulated Display Manager ────────────────────────────────

class SimDisplay implements GlassesDisplayManager {
  private bus: EventBus;
  private caps: GlassesCapabilities;
  private modelId: string;

  /** All display events received (for test assertions). */
  readonly history: DisplayEvent[] = [];

  private _last: DisplayEvent | null = null;
  private waitResolvers: Array<{
    resolve: (event: DisplayEvent) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(bus: EventBus, caps: GlassesCapabilities, modelId: string) {
    this.bus = bus;
    this.caps = caps;
    this.modelId = modelId;
  }

  private check(): void {
    if (!this.caps.hasDisplay)
      throw new MentraCapabilityError("display", this.modelId);
  }

  showText(text: string): void {
    this.check();
    const event: DisplayEvent = {
      type: "text",
      view: "main",
      packageName: "simulated",
      payload: { text },
    };
    this.pushEvent(event);
  }

  showTextWall(text: string): void {
    this.check();
    const event: DisplayEvent = {
      type: "text_wall",
      view: "main",
      packageName: "simulated",
      payload: { text },
    };
    this.pushEvent(event);
  }

  clear(): void {
    this.check();
    const event: DisplayEvent = {
      type: "clear",
      view: "main",
      packageName: "simulated",
      payload: {},
    };
    this.pushEvent(event);
  }

  /** Most recent display event. */
  get last(): DisplayEvent | null {
    return this._last;
  }

  /** Wait for the next display event (for test assertions). */
  waitFor(options?: { timeout?: number; type?: string }): Promise<DisplayEvent> {
    const timeout = options?.timeout ?? 5000;
    return new Promise<DisplayEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove this resolver from the list on timeout
        const idx = this.waitResolvers.findIndex((r) => r.timer === timer);
        if (idx !== -1) this.waitResolvers.splice(idx, 1);
        reject(new Error(`waitFor timed out after ${timeout}ms`));
      }, timeout);
      this.waitResolvers.push({ resolve, timer });
    });
  }

  /** Clear recorded history and last event. */
  clearHistory(): void {
    this.history.length = 0;
    this._last = null;
  }

  private pushEvent(event: DisplayEvent): void {
    this._last = event;
    this.history.push(event);
    this.bus.emit("display", event);

    // Resolve any pending waiters
    const resolvers = [...this.waitResolvers];
    this.waitResolvers = [];
    for (const { resolve, timer } of resolvers) {
      clearTimeout(timer);
      resolve(event);
    }
  }
}

// ── Simulated Camera Manager ─────────────────────────────────

class SimCamera implements GlassesCameraManager {
  private caps: GlassesCapabilities;
  private modelId: string;
  private nextPhoto: {
    data: Uint8Array;
    mimeType: string;
    width: number;
    height: number;
  } | null = null;

  constructor(caps: GlassesCapabilities, modelId: string) {
    this.caps = caps;
    this.modelId = modelId;
  }

  async takePhoto(options?: {
    size?: string;
    silent?: boolean;
  }): Promise<{ data: Uint8Array; mimeType: string; width: number; height: number }> {
    if (!this.caps.hasCamera)
      throw new MentraCapabilityError("camera", this.modelId);

    if (this.nextPhoto) {
      const photo = this.nextPhoto;
      this.nextPhoto = null;
      return photo;
    }

    // Return a tiny 1×1 JPEG stub
    return {
      data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
      mimeType: "image/jpeg",
      width: 1,
      height: 1,
    };
  }

  /** Configure what the next takePhoto() call returns. */
  setNextPhoto(
    data: Uint8Array,
    mimeType: string,
    width = 640,
    height = 480,
  ): void {
    this.nextPhoto = { data, mimeType, width, height };
  }
}

// ── Simulated Mic Manager ────────────────────────────────────

class SimMic implements GlassesMicManager {
  private bus: EventBus;
  private caps: GlassesCapabilities;
  private modelId: string;
  private _active = false;

  constructor(bus: EventBus, caps: GlassesCapabilities, modelId: string) {
    this.bus = bus;
    this.caps = caps;
    this.modelId = modelId;
  }

  get active(): boolean {
    return this._active;
  }

  start(): void {
    if (!this.caps.hasMic)
      throw new MentraCapabilityError("microphone", this.modelId);
    this._active = true;
  }

  stop(): void {
    this._active = false;
  }

  onChunk(handler: (pcm: Uint8Array) => void): () => void {
    if (!this.caps.hasMic)
      throw new MentraCapabilityError("microphone", this.modelId);
    return this.bus.on("mic_chunk", handler);
  }

  /** Feed raw PCM audio programmatically (for tests). */
  playBuffer(pcm: Uint8Array): void {
    this.bus.emit("mic_chunk", pcm);
  }

  /** Feed audio from a file in 50 ms chunks (for tests). */
  async playFile(path: string): Promise<void> {
    const file = Bun.file(path);
    const buffer = await file.arrayBuffer();
    const pcm = new Uint8Array(buffer);

    // 16 kHz mono 16-bit ≈ 1600 bytes per 50 ms
    const chunkSize = 1600;
    for (let i = 0; i < pcm.length; i += chunkSize) {
      const chunk = pcm.slice(i, Math.min(i + chunkSize, pcm.length));
      this.bus.emit("mic_chunk", chunk);
      await new Promise<void>((r) => setTimeout(r, 50));
    }
  }
}

// ── Simulated LED Manager ────────────────────────────────────

class SimLed implements GlassesLedManager {
  private caps: GlassesCapabilities;
  private modelId: string;

  readonly history: Array<{ on: boolean; color?: string; durationMs?: number }> =
    [];
  private _state = { on: false, color: null as string | null };

  constructor(caps: GlassesCapabilities, modelId: string) {
    this.caps = caps;
    this.modelId = modelId;
  }

  /** Current LED state snapshot. */
  get state() {
    return { ...this._state };
  }

  set(options: { color: string; durationMs?: number }): void {
    if (!this.caps.hasLight)
      throw new MentraCapabilityError("LED", this.modelId);
    this._state = { on: true, color: options.color };
    this.history.push({ on: true, ...options });
  }

  off(): void {
    if (!this.caps.hasLight)
      throw new MentraCapabilityError("LED", this.modelId);
    this._state = { on: false, color: null };
    this.history.push({ on: false });
  }
}

// ── Simulated Device Manager ─────────────────────────────────

class SimDevice implements GlassesDeviceManager {
  private bus: EventBus;

  private _battery: number | null;
  private _charging = false;
  private _firmware: string | null = "1.0.0-sim";

  constructor(bus: EventBus, battery: number) {
    this.bus = bus;
    this._battery = battery;
  }

  get batteryLevel(): number | null {
    return this._battery;
  }

  get charging(): boolean {
    return this._charging;
  }

  get firmwareVersion(): string | null {
    return this._firmware;
  }

  onButtonPress(handler: (event: ButtonEvent) => void): () => void {
    return this.bus.on("button_press", handler);
  }

  onTouch(handler: (event: MentraTouchEvent) => void): () => void {
    return this.bus.on("touch", handler);
  }

  onBatteryUpdate(
    handler: (level: number, charging: boolean) => void,
  ): () => void {
    return this.bus.on("battery", handler);
  }

  // ── Simulation controls ───────────────────────────────────

  /** Simulate a physical button press. */
  pressButton(
    buttonId: string,
    type: "short" | "long" | "double" = "short",
  ): void {
    const event: ButtonEvent = { buttonId, pressType: type };
    this.bus.emit("button_press", event);
  }

  /** Simulate a touchpad gesture. */
  touch(type: MentraTouchEvent["type"], x?: number, y?: number): void {
    const event: MentraTouchEvent = { type, x, y };
    this.bus.emit("touch", event);
  }

  /** Simulate a battery level change. */
  setBattery(level: number, charging = false): void {
    this._battery = level;
    this._charging = charging;
    this.bus.emit("battery", level, charging);
  }
}

// ── SimulatedGlasses ─────────────────────────────────────────

export class SimulatedGlasses implements Glasses {
  private bus = new EventBus();
  private profile: DeviceProfile;
  private _connected = true;

  readonly display: SimDisplay;
  readonly camera: SimCamera;
  readonly mic: SimMic;
  readonly led: SimLed;
  readonly device: SimDevice;

  private constructor(profile: DeviceProfile, battery = 85) {
    this.profile = profile;
    this.display = new SimDisplay(
      this.bus,
      profile.capabilities,
      profile.modelId,
    );
    this.camera = new SimCamera(profile.capabilities, profile.modelId);
    this.mic = new SimMic(this.bus, profile.capabilities, profile.modelId);
    this.led = new SimLed(profile.capabilities, profile.modelId);
    this.device = new SimDevice(this.bus, battery);
  }

  // ── Static Factories ──────────────────────────────────────

  static G1(): SimulatedGlasses {
    return new SimulatedGlasses(PROFILES["g1"]);
  }

  static MentraLive(): SimulatedGlasses {
    return new SimulatedGlasses(PROFILES["mentra-live"]);
  }

  static Mach1(): SimulatedGlasses {
    return new SimulatedGlasses(PROFILES["mach1"]);
  }

  static MentraNex(): SimulatedGlasses {
    return new SimulatedGlasses(PROFILES["mentra-nex"]);
  }

  static custom(profile: DeviceProfile): SimulatedGlasses {
    return new SimulatedGlasses(profile);
  }

  // ── Glasses interface ─────────────────────────────────────

  get model(): string {
    return this.profile.modelId;
  }

  get capabilities(): GlassesCapabilities {
    return { ...this.profile.capabilities };
  }

  isConnected(): boolean {
    return this._connected;
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    this.bus.emit("disconnected", "intentional");
  }

  // ── Simulation lifecycle ──────────────────────────────────

  /** Simulate an unexpected disconnect. */
  simulateDisconnect(reason = "simulated"): void {
    this._connected = false;
    this.bus.emit("disconnected", reason);
  }

  /** Simulate reconnection after a disconnect. */
  simulateReconnect(): void {
    this._connected = true;
  }

  /** Tear down all internal state and listeners. */
  destroy(): void {
    this._connected = false;
    this.bus.removeAll();
  }
}
