import { CloudToAppMessageType } from "@mentra/sdk";

import { logger as rootLogger } from "../logging/pino-logger";

import type { AppServerWebSocket } from "./types";

const logger = rootLogger.child({ service: "DeferredAppConnectionRegistry" });

export type DeferredAppConnectionReason = "booting" | "awaiting_app_restore";

export interface DeferredAppConnection {
  userId: string;
  packageName: string;
  sdkVersion: string;
  apiKey?: string;
  priorSessionId?: string;
  websocket: AppServerWebSocket;
  connectedAt: Date;
  expiresAt: Date;
  reason: DeferredAppConnectionReason;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class DeferredAppConnectionRegistry {
  private static instance: DeferredAppConnectionRegistry;

  private readonly byKey = new Map<string, DeferredAppConnection>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly bySocket = new WeakMap<AppServerWebSocket, string>();

  static getInstance(): DeferredAppConnectionRegistry {
    if (!DeferredAppConnectionRegistry.instance) {
      DeferredAppConnectionRegistry.instance = new DeferredAppConnectionRegistry();
    }
    return DeferredAppConnectionRegistry.instance;
  }

  register(
    input: Omit<DeferredAppConnection, "connectedAt" | "expiresAt">,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): void {
    const key = this.makeKey(input.userId, input.packageName);
    const existing = this.byKey.get(key);

    if (existing && existing.websocket !== input.websocket) {
      logger.info({ userId: input.userId, packageName: input.packageName }, "Replacing older deferred app socket");
      try {
        existing.websocket.close(1013, "Superseded by newer deferred connection");
      } catch {
        // Ignore close failures on already-closing sockets
      }
    }

    const entry: DeferredAppConnection = {
      ...input,
      connectedAt: new Date(),
      expiresAt: new Date(Date.now() + timeoutMs),
    };

    this.clearTimer(key);
    this.byKey.set(key, entry);
    this.bySocket.set(input.websocket, key);
    this.timers.set(
      key,
      setTimeout(() => {
        const activeEntry = this.byKey.get(key);
        if (!activeEntry || activeEntry.websocket !== input.websocket) {
          return;
        }

        this.byKey.delete(key);
        this.timers.delete(key);

        try {
          activeEntry.websocket.send(
            JSON.stringify({
              type: CloudToAppMessageType.RECONNECT_REJECTED,
              code: "BOOT_TIMEOUT",
              message: "Cloud did not restore app state before the deferred reconnect timed out",
              timestamp: new Date(),
            }),
          );
        } finally {
          try {
            activeEntry.websocket.close(1008, "Deferred reconnect timed out");
          } catch {
            // Ignore close failures on already-closed sockets
          }
        }
      }, timeoutMs),
    );
  }

  consume(userId: string, packageName: string): DeferredAppConnection | undefined {
    const key = this.makeKey(userId, packageName);
    const entry = this.byKey.get(key);
    if (!entry) {
      return undefined;
    }

    this.byKey.delete(key);
    this.clearTimer(key);
    return entry;
  }

  removeSocket(ws: AppServerWebSocket): void {
    const key = this.bySocket.get(ws);
    if (!key) {
      return;
    }

    const entry = this.byKey.get(key);
    if (entry?.websocket === ws) {
      this.byKey.delete(key);
      this.clearTimer(key);
    }
  }

  isExpired(entry: DeferredAppConnection): boolean {
    return entry.expiresAt.getTime() <= Date.now();
  }

  private makeKey(userId: string, packageName: string): string {
    return `${userId}::${packageName}`;
  }

  private clearTimer(key: string): void {
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }
}

export const deferredAppConnectionRegistry = DeferredAppConnectionRegistry.getInstance();
