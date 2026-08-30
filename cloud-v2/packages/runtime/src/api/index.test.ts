import { describe, expect, test } from "bun:test";

import { createApiApp } from "./index";

describe("Runtime API composition", () => {
  test("serves configured deployment and legal documents without enabling other modules", async () => {
    const handle = createApiApp({
      readinessChecks: [],
      services: new Set(["meetings"]),
      deploymentManifest: '{"schemaVersion":1}\n',
      legalDocuments: { privacy: "<h1>Privacy</h1>", terms: "<h1>Terms</h1>" },
    });

    const manifest = await handle.app.request(
      "/.well-known/mentra-deployment.json",
    );
    expect(manifest.status).toBe(200);
    expect(await manifest.text()).toBe('{"schemaVersion":1}\n');

    const privacy = await handle.app.request("/legal/privacy");
    expect(privacy.status).toBe(200);
    expect(await privacy.text()).toBe("<h1>Privacy</h1>");

    expect((await handle.app.request("/api/audio/session")).status).toBe(404);
    await handle.stop();
  });
});
