import { spawn } from "child_process";
import { PCMSink } from "./audio";

export class FFplaySink implements PCMSink {
  private ffplay?: any;

  constructor(params: { sampleRate: number; channels: number }) {
    // Use ffplay to play raw PCM audio
    this.ffplay = spawn(
      "ffplay",
      [
        "-f",
        "s16le",
        "-ar",
        params.sampleRate.toString(),
        "-ac",
        params.channels.toString(),
        "-nodisp",
        "-autoexit",
        "-",
      ],
      {
        stdio: ["pipe", "ignore", "ignore"],
      },
    );
  }

  write(buf: Uint8Array) {
    this.ffplay?.stdin.write(Buffer.from(buf));
  }

  close() {
    this.ffplay?.stdin.end();
    this.ffplay?.kill();
  }
}
