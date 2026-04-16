import { EventBus } from "../EventBus";
import type { DisplayEvent, DisplayState, DisplayView } from "../types";

export class DisplayManager {
  private bus = new EventBus();
  private _state: DisplayState = {
    currentEvent: null,
    mainEvent: null,
    dashboardEvent: null,
    activeView: "main",
  };

  get state(): DisplayState { return { ...this._state }; }
  get currentEvent(): DisplayEvent | null { return this._state.currentEvent; }
  get mainEvent(): DisplayEvent | null { return this._state.mainEvent; }
  get dashboardEvent(): DisplayEvent | null { return this._state.dashboardEvent; }
  get activeView(): DisplayView { return this._state.activeView; }

  setActiveView(view: DisplayView): void {
    this._state.activeView = view;
    this._state.currentEvent = view === "main" ? this._state.mainEvent : this._state.dashboardEvent;
    this.bus.emit("changed", this.state);
  }

  /** Called internally when a display event arrives from the cloud */
  handleEvent(event: DisplayEvent): void {
    if (event.type === "clear") {
      if (event.view === "main") this._state.mainEvent = null;
      else this._state.dashboardEvent = null;
      this.bus.emit("cleared", event.view);
    } else {
      if (event.view === "main" || !event.view) this._state.mainEvent = event;
      else this._state.dashboardEvent = event;
    }

    this._state.currentEvent = this._state.activeView === "main"
      ? this._state.mainEvent
      : this._state.dashboardEvent;

    this.bus.emit("event", event);
    this.bus.emit("changed", this.state);
  }

  on(event: "changed", handler: (state: DisplayState) => void): () => void;
  on(event: "event", handler: (event: DisplayEvent) => void): () => void;
  on(event: "cleared", handler: (view: DisplayView) => void): () => void;
  on(event: string, handler: (...args: any[]) => void): () => void {
    return this.bus.on(event, handler);
  }

  destroy(): void { this.bus.removeAll(); }
}
