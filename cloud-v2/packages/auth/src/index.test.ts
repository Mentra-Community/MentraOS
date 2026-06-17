import crypto from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import * as jose from "jose";

import {
  MiniappAuthError,
  createMiniappAuthVerifier,
  extractBearerToken,
  miniappJwksUrl,
} from "./index";

const TEST_PACKAGE = "com.test.miniapp";
const TEST_ISSUER = "mentra";

const keypair = crypto.generateKeyPairSync("ed25519");
const privatePem = keypair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicPem = keypair.publicKey.export({ type: "spki", format: "pem" }).toString();
const publicKey = await jose.importSPKI(publicPem, "EdDSA", { extractable: true });
const publicJwk = await jose.exportJWK(publicKey);
const jwks = {
  keys: [{ ...publicJwk, alg: "EdDSA", use: "sig", kid: "mentra-miniapp-1" }],
};

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/.well-known/jwks.json") {
      return Response.json(jwks);
    }
    return new Response("not found", { status: 404 });
  },
});

afterAll(() => {
  server.stop(true);
});

describe("@mentra/auth miniapp auth", () => {
  test("verifies a miniapp token from Core JWKS", async () => {
    const token = await mintMiniappToken(TEST_PACKAGE);
    const verifier = createMiniappAuthVerifier({
      packageName: TEST_PACKAGE,
      coreUrl: server.url.origin,
    });

    const verified = await verifier.verifyAuthHeader(`Bearer ${token}`);

    expect(verified.mentraUserId).toBe("user_123");
    expect(verified.oemId).toBe("test-oem");
    expect(verified.packageName).toBe(TEST_PACKAGE);
    expect(verified.tokenId).toBe("token_123");
  });

  test("rejects a token minted for another packageName", async () => {
    const token = await mintMiniappToken("com.other.app");
    const verifier = createMiniappAuthVerifier({
      packageName: TEST_PACKAGE,
      jwksUrl: `${server.url.origin}/.well-known/jwks.json`,
    });

    await expect(verifier.verifyToken(token)).rejects.toBeInstanceOf(MiniappAuthError);
  });

  test("extractBearerToken accepts Bearer auth and rejects missing auth", () => {
    expect(extractBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(() => extractBearerToken(undefined)).toThrow(MiniappAuthError);
  });

  test("miniappJwksUrl derives the standard Core JWKS endpoint", () => {
    expect(miniappJwksUrl({ coreUrl: "https://core.dev.us-west-2.mentraglass.com/" })).toBe(
      "https://core.dev.us-west-2.mentraglass.com/.well-known/jwks.json",
    );
  });
});

async function mintMiniappToken(audience: string): Promise<string> {
  const privateKey = await jose.importPKCS8(privatePem, "EdDSA");
  return new jose.SignJWT({ oemId: "test-oem" })
    .setProtectedHeader({ alg: "EdDSA", kid: "mentra-miniapp-1" })
    .setIssuer(TEST_ISSUER)
    .setAudience(audience)
    .setSubject("user_123")
    .setJti("token_123")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}
