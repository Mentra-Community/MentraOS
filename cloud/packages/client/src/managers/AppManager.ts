import { EventBus } from "../EventBus";
import type { AppInfo } from "../types";

export class AppManager {
  private bus = new EventBus();
  private _installed: AppInfo[] = [];
  private _running: AppInfo[] = [];

  get installed(): AppInfo[] { return [...this._installed]; }
  get running(): AppInfo[] { return [...this._running]; }
  get foreground(): AppInfo[] { return this._running.filter(a => a.type === "standard"); }
  get activeForeground(): AppInfo | null { return this.foreground[0] ?? null; }
  get backgroundRunning(): AppInfo[] { return this._running.filter(a => a.type === "background"); }

  async start(packageName: string): Promise<void> {
    // In real implementation, this would send a message to the cloud
    // For now, just update local state
    const app = this._installed.find(a => a.packageName === packageName);
    if (app) {
      app.running = true;
      app.loading = false;
      this._running = this._installed.filter(a => a.running);
      this.bus.emit("started", app);
      this.bus.emit("changed");
    }
  }

  async stop(packageName: string): Promise<void> {
    const app = this._installed.find(a => a.packageName === packageName);
    if (app) {
      app.running = false;
      this._running = this._installed.filter(a => a.running);
      this.bus.emit("stopped", app);
      this.bus.emit("changed");
    }
  }

  async stopAll(): Promise<void> {
    for (const app of this._running) {
      app.running = false;
      this.bus.emit("stopped", app);
    }
    this._running = [];
    this.bus.emit("changed");
  }

  get(packageName: string): AppInfo | undefined {
    return this._installed.find(a => a.packageName === packageName);
  }

  async refresh(): Promise<void> {
    // In real implementation, fetch from cloud
    this.bus.emit("changed");
  }

  // ── Internal: update from cloud messages ───────────────────

  /** Called when the cloud sends an updated app list */
  updateInstalledApps(apps: AppInfo[]): void {
    this._installed = apps;
    this._running = apps.filter(a => a.running);
    this.bus.emit("changed");
  }

  /** Called when the cloud sends an app state change */
  updateAppState(packageName: string, running: boolean): void {
    const app = this._installed.find(a => a.packageName === packageName);
    if (app) {
      app.running = running;
      this._running = this._installed.filter(a => a.running);
      this.bus.emit(running ? "started" : "stopped", app);
      this.bus.emit("changed");
    }
  }

  // ── Events ─────────────────────────────────────────────────

  on(event: "started", handler: (app: AppInfo) => void): () => void;
  on(event: "stopped", handler: (app: AppInfo) => void): () => void;
  on(event: "changed", handler: () => void): () => void;
  on(event: string, handler: (...args: any[]) => void): () => void {
    return this.bus.on(event, handler);
  }

  destroy(): void { this.bus.removeAll(); }
}
