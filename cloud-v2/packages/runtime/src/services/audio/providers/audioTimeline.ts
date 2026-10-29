import type { AudioPosition } from "@mentra/cloud-protocol";

/** Maps Soniox's contiguous submitted-sample clock back to phone frame positions. */
export class AudioTimeline {
  private endMs = 0;
  private spans: Array<{
    start: number;
    end: number;
    position?: AudioPosition;
  }> = [];

  add(sampleCount: number, position?: AudioPosition): void {
    const end = this.endMs + sampleCount / 16;
    this.spans.push({ start: this.endMs, end, position });
    this.endMs = end;
  }

  at(startMs: number): AudioPosition | undefined {
    const span = this.spans.find((s) => startMs >= s.start && startMs < s.end);
    return (
      span?.position && {
        sessionTag: span.position.sessionTag,
        offsetMs: span.position.offsetMs + startMs - span.start,
      }
    );
  }

  prune(beforeMs: number): void {
    this.spans = this.spans.filter((s) => s.end > beforeMs);
  }

  reset(): void {
    this.endMs = 0;
    this.spans = [];
  }
}
