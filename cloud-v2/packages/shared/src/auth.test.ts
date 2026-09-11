import crypto from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";

import {
  resetRuntimeAuthCache,
  signRuntimeToken,
  verifyRuntimeToken,
} from "./auth";

const savedEnv = {
  CLOUD_RUNTIME_AUTH_AUDIENCE: process.env.CLOUD_RUNTIME_AUTH_AUDIENCE,
  CLOUD_RUNTIME_AUTH_ISSUERS: process.env.CLOUD_RUNTIME_AUTH_ISSUERS,
  TEST_RUNTIME_PUBLIC_KEY: process.env.TEST_RUNTIME_PUBLIC_KEY,
};

afterEach(() => {
  restoreEnv("CLOUD_RUNTIME_AUTH_AUDIENCE", savedEnv.CLOUD_RUNTIME_AUTH_AUDIENCE);
  restoreEnv("CLOUD_RUNTIME_AUTH_ISSUERS", savedEnv.CLOUD_RUNTIME_AUTH_ISSUERS);
  restoreEnv("TEST_RUNTIME_PUBLIC_KEY", savedEnv.TEST_RUNTIME_PUBLIC_KEY);
  resetRuntimeAuthCache();
});

describe("runtime token verification", () => {
  test("requires explicit runtime issuer config", async () => {
    delete process.env.CLOUD_RUNTIME_AUTH_ISSUERS;

    await expect(verifyRuntimeToken("not-a-runtime-token")).rejects.toThrow(
      "runtime auth issuer config is required",
    );
  });

  test("accepts a configured cloud-runtime issuer", async () => {
    const keypair = createEd25519Keypair();
    process.env.TEST_RUNTIME_PUBLIC_KEY = keypair.publicKey;
    process.env.CLOUD_RUNTIME_AUTH_ISSUERS = JSON.stringify([
      {
        issuer: "test-runtime",
        publicKeyEnv: "TEST_RUNTIME_PUBLIC_KEY",
        userIdClaim: "sub",
        tenantIdClaim: "tenant_id",
      },
    ]);

    const token = await signRuntimeToken({
      privateKey: keypair.privateKey,
      issuer: "test-runtime",
      subject: "user-1",
      tenantId: "oem-1",
      jti: "runtime-jti",
      expiresInSeconds: 60,
    });

    await expect(verifyRuntimeToken(token)).resolves.toEqual({
      mentraUserId: "user-1",
      tenantId: "oem-1",
      sessionId: "runtime_runtime-jti",
      jti: "runtime-jti",
    });
  });

  test("accepts legacy issuer tenant config while preferring tenant_id tokens", async () => {
    const keypair = createEd25519Keypair();
    process.env.TEST_RUNTIME_PUBLIC_KEY = keypair.publicKey;
    process.env.CLOUD_RUNTIME_AUTH_ISSUERS = JSON.stringify([
      {
        issuer: "test-runtime",
        publicKeyEnv: "TEST_RUNTIME_PUBLIC_KEY",
        userIdClaim: "sub",
        oemIdClaim: "oem_id",
      },
    ]);

    const token = await signRuntimeToken({
      privateKey: keypair.privateKey,
      issuer: "test-runtime",
      subject: "user-1",
      tenantId: "tenant-1",
      jti: "runtime-jti",
      expiresInSeconds: 60,
    });

    await expect(verifyRuntimeToken(token)).resolves.toEqual({
      mentraUserId: "user-1",
      tenantId: "tenant-1",
      sessionId: "runtime_runtime-jti",
      jti: "runtime-jti",
    });
  });

  test("accepts legacy fixed OEM config as fixed tenant config", async () => {
    const keypair = createEd25519Keypair();
    process.env.TEST_RUNTIME_PUBLIC_KEY = keypair.publicKey;
    process.env.CLOUD_RUNTIME_AUTH_ISSUERS = JSON.stringify([
      {
        issuer: "test-runtime",
        publicKeyEnv: "TEST_RUNTIME_PUBLIC_KEY",
        userIdClaim: "sub",
        fixedOemId: "tenant-legacy",
      },
    ]);

    const token = await signRuntimeToken({
      privateKey: keypair.privateKey,
      issuer: "test-runtime",
      subject: "user-1",
      tenantId: "tenant-token",
      jti: "runtime-jti",
      expiresInSeconds: 60,
    });

    await expect(verifyRuntimeToken(token)).resolves.toEqual({
      mentraUserId: "user-1",
      tenantId: "tenant-legacy",
      sessionId: "runtime_runtime-jti",
      jti: "runtime-jti",
    });
  });

  test("rejects tokens with the wrong audience", async () => {
    const keypair = createEd25519Keypair();
    process.env.TEST_RUNTIME_PUBLIC_KEY = keypair.publicKey;
    process.env.CLOUD_RUNTIME_AUTH_ISSUERS = JSON.stringify([
      {
        issuer: "test-runtime",
        publicKeyEnv: "TEST_RUNTIME_PUBLIC_KEY",
        userIdClaim: "sub",
        fixedTenantId: "oem-1",
      },
    ]);

    const token = await signRuntimeToken({
      privateKey: keypair.privateKey,
      issuer: "test-runtime",
      audience: "cloud-core",
      subject: "user-1",
      tenantId: "oem-1",
      expiresInSeconds: 60,
    });

    await expect(verifyRuntimeToken(token)).rejects.toThrow("runtime_token rejected");
  });
});

function createEd25519Keypair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return {
    privateKey: stripPem(privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
    publicKey: stripPem(publicKey.export({ type: "spki", format: "pem" }).toString()),
  };
}

function stripPem(pem: string): string {
  return pem
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "");
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
