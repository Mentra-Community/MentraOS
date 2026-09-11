/**
 * @fileoverview The single typed event emitter behind `cloud.runtime`'s `on*`.
 *
 * There is exactly one emitter so there is one source of truth for runtime
 * events: the friendly per-event methods (`onTranscript`, `onConnected`, ...),
 * the generic `on(event, cb)`, and `onAny(cb)` are all thin wrappers over this.
 * Keying by an event map (`RuntimeEvents`) means event names are checked by the
 * compiler and payloads are typed, so there are no magic strings to mistype.
 *
 * See docs/issues/004-cloud-client/design.md ("src/modules/runtime/emitter.ts").
 */
import type {
  TranscriptionData,
  TranslationData,
  ProtocolError,
} from "@mentra/cloud-protocol";
import type { RuntimeSnapshot } from "./status";

/**
 * The runtime event map: event name to payload type.
 *
 * `transcript` / `translation` carry the canonical wire result types, so a
 * consumer gets exactly what the cloud sent. `connected` has no payload (the
 * fact of connecting is the whole signal), so its type is `void`. `error`
 * carries the wire `ProtocolError` (a non-fatal one; fatal ones close the
 * socket and surface as a reconnect), not a thrown JS error.
 */
export interface RuntimeEvents {
  transcript: TranscriptionData;
  translation: TranslationData;
  connected: void;
  disconnected: { reason: string };
  status: RuntimeSnapshot;
  error: ProtocolError;
}

/** A handler stored for a single event name, payload typed by the map. */
type Listener<K extends keyof RuntimeEvents> = (data: RuntimeEvents[K]) => void;

/** A handler that receives every event, used for forwarding and logging. */
type AnyListener = (event: keyof RuntimeEvents, data: unknown) => void;

/**
 * A typed multi-listener emitter for runtime events.
 *
 * Listeners are kept in a `Set` per event so the same handler is not registered
 * twice and `off` is an O(1) removal. `onAny` listeners are kept separately and
 * fired on every `emit`, which is what powers island re-emitting all runtime
 * events without naming each one.
 */
export class RuntimeEmitter {
  // One listener set per event name. A `Map` keyed by the event name keeps
  // dispatch touching only the handlers for the event that fired. The stored set
  // is typed loosely (the element type varies per key, which a single field
  // cannot express); the public `on`/`off`/`emit` signatures below are fully
  // typed via the event map, so callers never see the loose inner type.
  private readonly listeners = new Map<
    keyof RuntimeEvents,
    Set<Listener<keyof RuntimeEvents>>
  >();

  // Listeners that want every event, kept apart so `emit` can fan out to them
  // after the per-event handlers run.
  private readonly anyListeners = new Set<AnyListener>();

  /**
   * Subscribe to one event. Returns an unsubscribe function, which is the only
   * way callers are expected to detach: holding the returned function means a
   * caller never needs a reference to the original handler to remove it.
   */
  on<K extends keyof RuntimeEvents>(e: K, cb: Listener<K>): () => void {
    let set = this.listeners.get(e);
    if (!set) {
      set = new Set();
      this.listeners.set(e, set);
    }
    set.add(cb as Listener<keyof RuntimeEvents>);
    return () => this.off(e, cb);
  }

  /**
   * Remove a previously registered handler for one event. A no-op if the handler
   * was never registered, so double-unsubscribe is safe.
   */
  off<K extends keyof RuntimeEvents>(e: K, cb: Listener<K>): void {
    this.listeners.get(e)?.delete(cb as Listener<keyof RuntimeEvents>);
  }

  /**
   * Subscribe to every event in one handler (for forwarding, iteration, or
   * logging). The payload is `unknown` because it varies per event; a consumer
   * narrows on the event name. Returns an unsubscribe function like `on`.
   */
  onAny(cb: AnyListener): () => void {
    this.anyListeners.add(cb);
    return () => {
      this.anyListeners.delete(cb);
    };
  }

  /**
   * Deliver an event to its handlers, then to every `onAny` handler.
   *
   * We iterate over a copy of each listener set so a handler that subscribes or
   * unsubscribes during dispatch does not mutate the set we are walking. A throw
   * from one handler must not stop the others or skip the `onAny` fan-out, so
   * each call is isolated and a failure is swallowed (the emitter has no logger;
   * a handler owns its own error handling).
   */
  emit<K extends keyof RuntimeEvents>(e: K, d: RuntimeEvents[K]): void {
    const set = this.listeners.get(e);
    if (set) {
      for (const cb of [...set]) {
        try {
          (cb as Listener<K>)(d);
        } catch {
          // A misbehaving listener must not break delivery to the others.
        }
      }
    }
    for (const cb of [...this.anyListeners]) {
      try {
        cb(e, d);
      } catch {
        // Same isolation for the catch-all listeners.
      }
    }
  }
}
