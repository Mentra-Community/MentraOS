import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { resetRuntimeAuthCache, signRuntimeToken } from "@mentra/cloud-shared";

import { meetingsApi } from "./meetings.api";
import {
  resetAcsTeamsAuthCache,
  setAcsIdentityClientForTests,
  type AcsIdentityClient,
} from "../services/meetings/acs-teams.service";

const ISSUER = "https://core.private-test.example";
const savedEnv = new Map<string, string | undefined>();
let privateKey: string;

describe("Runtime ACS credential API", () => {
  beforeAll(() => {
    const keys = crypto.generateKeyPairSync("ed25519");
    privateKey = stripPem(keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const publicKey = stripPem(keys.publicKey.export({ type: "spki", format: "pem" }).toString());
    setEnv(
      "CLOUD_RUNTIME_AUTH_ISSUERS",
      JSON.stringify([
        {
          issuer: ISSUER,
          publicKey,
          userIdClaim: "sub",
          tenantIdClaim: "tenant_id",
          algorithms: ["EdDSA"],
        },
      ]),
    );
    setEnv("CLOUD_RUNTIME_AUTH_AUDIENCE", "cloud-runtime");
    setEnv("ACS_CONNECTION_STRING", "endpoint=https://test.communication.azure.com/;accesskey=test");
    deleteEnv("ENTRA_TENANT_ID");
    deleteEnv("ENTRA_CLIENT_ID");
    resetRuntimeAuthCache();
    setAcsIdentityClientForTests({
      async createUserAndToken() {
        return {
          token: "guest-token",
          expiresOn: new Date("2030-01-01T00:00:00.000Z"),
          user: { communicationUserId: "guest-user" },
        };
      },
      async getTokenForTeamsUser() {
        throw new Error("not used");
      },
    } satisfies AcsIdentityClient);
  });

  afterAll(() => {
    resetAcsTeamsAuthCache();
    resetRuntimeAuthCache();
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test("requires Runtime authentication", async () => {
    expect((await app().request("/api/meetings/acs/token", { method: "POST" })).status).toBe(401);
  });

  test("issues a guest credential without requiring Entra configuration", async () => {
    const response = await app().request("/api/meetings/acs/token", {
      method: "POST",
      headers: { authorization: `Bearer ${await runtimeToken()}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      token: "guest-token",
      expiresOn: "2030-01-01T00:00:00.000Z",
      identityMode: "guest",
      acsUserId: "guest-user",
    });
  });

  test("does not reinterpret a supplied employee token as a guest request", async () => {
    const response = await app().request("/api/meetings/acs/token", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${await runtimeToken()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ teamsUserAadToken: "x".repeat(100) }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Teams identity exchange rejected",
    });
  });

  test("rejects oversized credential requests before parsing them", async () => {
    const response = await app().request("/api/meetings/acs/token", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${await runtimeToken()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ teamsUserAadToken: "x".repeat(17 * 1024) }),
    });

    expect(response.status).toBe(413);
  });
});

function app(): Hono {
  const app = new Hono();
  app.route("/api/meetings", meetingsApi);
  return app;
}

function runtimeToken(): Promise<string> {
  return signRuntimeToken({
    privateKey,
    issuer: ISSUER,
    subject: "user-1",
    tenantId: "tenant-1",
    sessionId: "session-1",
    expiresInSeconds: 300,
  });
}

function stripPem(value: string): string {
  return value.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
}

function setEnv(name: string, value: string): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  process.env[name] = value;
}

function deleteEnv(name: string): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  delete process.env[name];
}
