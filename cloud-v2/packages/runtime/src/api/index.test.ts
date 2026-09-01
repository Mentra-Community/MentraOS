import { describe, expect, test } from "bun:test";

import { createApiApp } from "./index";

describe("Runtime API composition", () => {
  test("serves configured deployment and legal documents without enabling other modules", async () => {
    const app = createApiApp({
      readinessChecks: [],
      services: new Set(["meetings"]),
      deploymentManifest: '{"schemaVersion":1}\n',
      legalDocuments: { privacy: "<h1>Privacy</h1>", terms: "<h1>Terms</h1>" },
    });

    const manifest = await app.request(
      "/.well-known/mentra-deployment.json",
    );
    expect(manifest.status).toBe(200);
    expect(await manifest.text()).toBe('{"schemaVersion":1}\n');

    const privacy = await app.request("/legal/privacy");
    expect(privacy.status).toBe(200);
    expect(await privacy.text()).toBe("<h1>Privacy</h1>");

    expect((await app.request("/api/audio/session")).status).toBe(404);
  });

  test("serves the minimum client version policy in every profile", async () => {
    const previousRequired = process.env.CLOUD_CLIENT_MIN_VERSION;
    const previousRecommended = process.env.CLOUD_CLIENT_RECOMMENDED_VERSION;
    process.env.CLOUD_CLIENT_MIN_VERSION = "3.1.0";
    process.env.CLOUD_CLIENT_RECOMMENDED_VERSION = "3.2.0";

    try {
      const app = createApiApp({
        readinessChecks: [],
        services: new Set(["meetings"]),
      });
      const response = await app.request("/api/client/min-version");

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        success: true,
        data: { required: "3.1.0", recommended: "3.2.0" },
      });
    } finally {
      if (previousRequired === undefined) delete process.env.CLOUD_CLIENT_MIN_VERSION;
      else process.env.CLOUD_CLIENT_MIN_VERSION = previousRequired;
      if (previousRecommended === undefined) delete process.env.CLOUD_CLIENT_RECOMMENDED_VERSION;
      else process.env.CLOUD_CLIENT_RECOMMENDED_VERSION = previousRecommended;
    }
  });
});
