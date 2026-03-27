import { Logger } from "pino";
import { logger as rootLogger } from "../logging/pino-logger";

// Type shim and runtime fallback for environments/TS configs without FinalizationRegistry lib types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const FinalizationRegistry: any;

/**
 * Lightweight leak detector using FinalizationRegistry.
 * - register(object, tag): tracks object and logs when GC finalizes it
 * - markDisposed(tag): records time of disposal, and if not finalized within grace period,
 *   emits a warning suggesting a potential leak
 */
class MemoryLeakDetector {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private finalizationRegistry: any | undefined;
  private disposedAtByTag = new Map<string, number>();
  private readonly logger: Logger;
  private readonly leakWarnAfterMs: number = 60_000; // warn if not GC'd within 60s after dispose

  constructor() {
    this.logger = rootLogger.child({ service: "MemoryLeakDetector" });

    try {
      if (typeof FinalizationRegistry !== "undefined") {
        this.finalizationRegistry = new FinalizationRegistry((tag: string) => {
          // Called by GC when object is collected
          const disposedAt = this.disposedAtByTag.get(tag);
          this.disposedAtByTag.delete(tag);
          this.logger.info({ tag, disposedAt }, "Object finalized by GC");
        });
      }
    } catch {
      this.finalizationRegistry = undefined;
    }
  }

  register(object: object, tag: string): void {
    if (!this.finalizationRegistry) return; // Not supported in this environment
    // Use the tag string as held value for finalization callback
    this.finalizationRegistry.register(object, tag);
    this.logger.debug({ tag }, "Registered object for leak detection");
  }

  markDisposed(tag: string): void {
    const now = Date.now();
    this.disposedAtByTag.set(tag, now);
    this.logger.debug(
      { tag },
      "Marked object as disposed; awaiting GC finalization",
    );

    // Schedule a check; if not finalized by then, warn
    setTimeout(() => {
      if (this.disposedAtByTag.has(tag)) {
        const disposedAt = this.disposedAtByTag.get(tag)!;
        this.logger.warn(
          { tag, disposedAt, warnAfterMs: this.leakWarnAfterMs },
          "Potential leak: object not GC-finalized within expected window",
        );
      }
    }, this.leakWarnAfterMs).unref?.();
  }

  /** Number of objects that were disposed but not yet finalized by GC. */
  getDisposedPendingGCCount(): number {
    return this.disposedAtByTag.size;
  }
}

export const memoryLeakDetector = new MemoryLeakDetector();
