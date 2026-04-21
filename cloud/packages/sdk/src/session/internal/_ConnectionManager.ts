import type { Logger } from "pino";
import { Transport, TransportState } from "../../transport/Transport";

interface ConnectableTransport extends Transport {
  connect?: () => Promise<void>;
}

export interface _ConnectionManagerDeps {
  transport: Transport;
  logger: Logger;
  autoReconnect: boolean;
  maxReconnectAttempts: number;
  reconnectDelay: number;
  onTransportReady: () => void;
  onTextMessage: (raw: string) => void;
  onBinaryMessage: (data: ArrayBuffer) => void;
  onClose: (info: { code: number; reason: string; permanent: boolean }) => void;
  onError: (error: Error) => void;
}

const PING_INTERVAL_MS = 15_000;

export class _ConnectionManager {
  private readonly deps: _ConnectionManagerDeps;

  private connected = false;
  private parked = false;
  private explicitDisconnect = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private parkedTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: _ConnectionManagerDeps) {
    this.deps = deps;
    this.attachTransportHandlers();
  }

  get isConnected(): boolean {
    return this.connected && this.deps.transport.readyState === TransportState.OPEN;
  }

  get isParked(): boolean {
    return this.parked;
  }

  async connect(): Promise<void> {
    this.explicitDisconnect = false;
    this.parked = false;
    this.stopParkedTimer();

    const transport = this.deps.transport as ConnectableTransport;
    if (typeof transport.connect === "function") {
      await transport.connect();
    } else if (this.deps.transport.readyState !== TransportState.OPEN) {
      throw new Error("Transport is not open and does not expose connect()");
    }

    this.deps.onTransportReady();
  }

  disconnect(): void {
    this.explicitDisconnect = true;
    this.parked = false;
    this.connected = false;
    this.stopReconnectTimer();
    this.stopPingInterval();
    this.stopParkedTimer();
    this.deps.transport.close(1000, "Client disconnect");
  }

  markConnected(): void {
    this.connected = true;
    this.parked = false;
    this.reconnectAttempts = 0;
    this.stopParkedTimer();
    this.startPingInterval();
  }

  park(timeoutMs: number, onTimeout: () => void): void {
    this.connected = false;
    this.parked = true;
    this.stopReconnectTimer();
    this.stopPingInterval();
    this.stopParkedTimer();

    this.parkedTimer = setTimeout(() => {
      this.parkedTimer = null;
      this.parked = false;
      onTimeout();
    }, timeoutMs);
  }

  destroy(): void {
    this.connected = false;
    this.parked = false;
    this.stopReconnectTimer();
    this.stopPingInterval();
    this.stopParkedTimer();
  }

  private attachTransportHandlers(): void {
    this.deps.transport.onMessage((raw) => {
      this.deps.onTextMessage(raw);
    });

    this.deps.transport.onBinary((data) => {
      this.deps.onBinaryMessage(data);
    });

    this.deps.transport.onClose((code, reason) => {
      const permanent = this.explicitDisconnect || !this.deps.autoReconnect;

      this.connected = false;
      this.stopPingInterval();
      this.deps.onClose({ code, reason, permanent });

      if (!permanent && !this.parked) {
        this.scheduleReconnect();
      }
    });

    this.deps.transport.onError((error) => {
      this.deps.onError(error);
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.deps.maxReconnectAttempts) {
      this.deps.onClose({
        code: 4000,
        reason: "Maximum reconnection attempts exceeded",
        permanent: true,
      });
      return;
    }

    const delay = this.deps.reconnectDelay * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.stopReconnectTimer();

    this.deps.logger.warn(
      { attempt: this.reconnectAttempts, delay },
      "MentraSession transport closed; scheduling reconnect",
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((error) => {
        this.deps.onError(error instanceof Error ? error : new Error(String(error)));
        this.scheduleReconnect();
      });
    }, delay);
  }

  private startPingInterval(): void {
    this.stopPingInterval();
    this.pingInterval = setInterval(() => {
      if (this.deps.transport.readyState !== TransportState.OPEN) {
        return;
      }

      this.deps.transport.send(JSON.stringify({ type: "ping" }));
    }, PING_INTERVAL_MS);
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private stopReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private stopParkedTimer(): void {
    if (this.parkedTimer) {
      clearTimeout(this.parkedTimer);
      this.parkedTimer = null;
    }
  }
}
