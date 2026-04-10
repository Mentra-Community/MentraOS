import { EventEmitter } from "events";
import type { AudioOutputStream } from "../managers/SpeakerManager";

export class _V2AudioStreamShim extends EventEmitter {
  readonly streamId: string;

  constructor(private readonly stream: AudioOutputStream) {
    super();
    this.streamId = stream.id;

    this.stream.onStateChange((state) => {
      if (state === "ended") {
        this.emit("close");
      }

      if (state === "error") {
        this.emit("error", new Error("Audio output stream entered error state"));
      }
    });
  }

  get state(): string {
    return this.stream.state;
  }

  write(chunk: Uint8Array): void {
    this.stream.write(chunk);
  }

  async end(): Promise<void> {
    await this.stream.end();
  }

  async flush(): Promise<void> {
    this.stream.flush();
  }
}
