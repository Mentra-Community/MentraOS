import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ReportArtifactView } from "./App";

// Synthetic artifact metadata only; no report or media is fetched.
const artifact = {
  artifactId: "art_SYNTHETIC",
  source: "phone",
  filename: "recording.mp4",
  sizeBytes: 16_638_399,
  createdAt: null,
};
const url = "/api/admin/reports/rep_SYNTHETIC/artifacts/art_SYNTHETIC";
const render = (overrides: { type: "video" | "screenshot"; contentType: string | null }) =>
  renderToStaticMarkup(<ReportArtifactView reportId="rep_SYNTHETIC" artifact={{ ...artifact, ...overrides }} />);

describe("incident report artifact view", () => {
  test("plays an MP4 video natively from its authenticated same-origin artifact URL", () => {
    const html = render({ type: "video", contentType: "video/mp4" });
    expect(html).toContain(`<video src="${url}"`);
    expect(html).toMatch(/<video[^>]* controls=""/);
    expect(html).toMatch(/<video[^>]* playsInline=""/i);
    expect(html).toMatch(/<video[^>]* preload="metadata"/);
    expect(html).not.toContain("blob:");
    expect(html).not.toContain("Download payload");
  });

  test("a video without a playable MP4 type stays a download, like other opaque payloads", () => {
    for (const contentType of [null, "application/octet-stream", "video/quicktime"]) {
      const html = render({ type: "video", contentType });
      expect(html).not.toContain("<video");
      expect(html).toContain(`href="${url}"`);
      expect(html).toContain("Download payload");
    }
  });

  test("an MP4 type on a non-video artifact does not render a player", () => {
    const html = render({ type: "screenshot", contentType: "video/mp4" });
    expect(html).not.toContain("<video");
    expect(html).toContain("Download payload");
  });
});
