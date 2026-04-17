import type { Logger } from "pino";
import { DataStreamRouter, MessageHandlerRegistry } from "../DataStreamRouter";

export class _MessageRouter {
  readonly messageHandlers = new MessageHandlerRegistry();
  readonly dataStreamRouter = new DataStreamRouter();

  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  handleRawText(raw: string): boolean {
    let message: any;

    try {
      message = JSON.parse(raw);
    } catch (error) {
      this.logger.warn({ raw }, "MentraSession received invalid JSON");
      throw error instanceof Error ? error : new Error(String(error));
    }

    if (!message?.type) {
      this.logger.debug({ message }, "MentraSession ignored message without type");
      return false;
    }

    const handled = this.messageHandlers.dispatch(message);
    if (!handled && message.type !== "pong") {
      this.logger.debug({ type: message.type }, "MentraSession received unhandled message type");
    }

    return handled;
  }

  destroy(): void {
    this.messageHandlers.clear();
  }
}
