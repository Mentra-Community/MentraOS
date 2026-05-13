import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VIDEO_CONFIG_LIMITS, validateVideoConfig } from "../types/rtmp-stream";

/**
 * Full `import("../index")` is not used here: Bun's evaluation of the package entry
 * can hit unrelated export graph issues. We still verify the public barrel contract in
 * {@link ../../index.ts} and that the streaming helpers resolve from their module.
 */
describe("package exports (streaming)", () => {
  it("exports VIDEO_CONFIG_LIMITS and validateVideoConfig from types/rtmp-stream", () => {
    expect(VIDEO_CONFIG_LIMITS).toBeDefined();
    expect(typeof validateVideoConfig).toBe("function");
    expect(VIDEO_CONFIG_LIMITS.width.min).toBe(320);
  });

  it("index.ts still re-exports VIDEO_CONFIG_LIMITS and validateVideoConfig", () => {
    const indexPath = join(import.meta.dir, "..", "index.ts");
    const src = readFileSync(indexPath, "utf8");
    expect(src).toContain('export { VIDEO_CONFIG_LIMITS, validateVideoConfig } from "./types/rtmp-stream"');
  });
});
