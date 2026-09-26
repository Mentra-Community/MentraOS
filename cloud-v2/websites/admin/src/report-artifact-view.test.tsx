import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { ReportArtifactView } from "./App";

// Synthetic artifact metadata only; no report or media is fetched.
const base = {
  artifactId: "art_SYNTHETIC",
  source: "host",
  filename: "recording.mp4",
  sizeBytes: 2184,
  createdAt: null,
};
const url = "/api/admin/reports/rep_SYNTHETIC/artifacts/art_SYNTHETIC";
type Overrides = { type: "video" | "screenshot" | "logs" | "state_snapshot"; contentType: string | null; filename?: string };
const render = (overrides: Overrides) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ReportArtifactView reportId="rep_SYNTHETIC" artifact={{ ...base, ...overrides }} />
    </QueryClientProvider>,
  );

describe("incident report artifact view", () => {
  test("plays an MP4 video natively from its authenticated same-origin artifact URL", () => {
    const html = render({ type: "video", contentType: "video/mp4" });
    expect(html).toContain(`<video src="${url}"`);
    expect(html).toMatch(/<video[^>]* controls=""/);
    expect(html).toMatch(/<video[^>]* playsInline=""/i);
    expect(html).toMatch(/<video[^>]* preload="metadata"/);
    // The header keeps the declared source and filename.
    expect(html).toContain("· host");
    expect(html).toContain("· recording.mp4");
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

  test("existing screenshot, log and opaque branches are unchanged", () => {
    const image = render({ type: "screenshot", contentType: "image/png", filename: "shot.png" });
    expect(image).toContain(`<img src="${url}"`);
    expect(image).not.toContain("<video");

    const heic = render({ type: "screenshot", contentType: "image/heic", filename: "shot.heic" });
    expect(heic).not.toContain("<img");
    expect(heic).toContain("Download payload");

    const logs = render({ type: "logs", contentType: "application/json", filename: "logs.json" });
    expect(logs).toContain("View log entries");

    const mislabeled = render({ type: "screenshot", contentType: "video/mp4" });
    expect(mislabeled).not.toContain("<video");
    expect(mislabeled).toContain("Download payload");
  });
});
