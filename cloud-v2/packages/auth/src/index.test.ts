import crypto from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import * as jose from "jose";

import {
  MentraAuthError,
  createMentraAuth,
  extractBearerToken,
  mentraJwksUrl,
} from "./index";

const TEST_PACKAGE = "com.test.miniapp";
const TEST_ISSUER = "cloud-core";

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
    const auth = createMentraAuth({
      packageName: TEST_PACKAGE,
      jwksUrl: `${server.url.origin}/.well-known/jwks.json`,
    });

    const verified = await auth.verifyAuthHeader(`Bearer ${token}`);

    expect(verified.mentraUserId).toBe("user_123");
    expect(verified.oemId).toBe("test-oem");
    expect(verified.packageName).toBe(TEST_PACKAGE);
    expect(verified.tokenId).toBe("token_123");
  });

  test("rejects a token minted for another packageName", async () => {
    const token = await mintMiniappToken("com.other.app");
    const auth = createMentraAuth({
      packageName: TEST_PACKAGE,
      jwksUrl: `${server.url.origin}/.well-known/jwks.json`,
    });

    await expect(auth.verifyToken(token)).rejects.toBeInstanceOf(MentraAuthError);
  });

  test("accepts one of several configured issuers", async () => {
    const token = await mintMiniappToken(TEST_PACKAGE, { issuer: "mentra" });
    const auth = createMentraAuth({
      packageName: TEST_PACKAGE,
      issuer: ["cloud-core", "mentra"],
      jwksUrl: `${server.url.origin}/.well-known/jwks.json`,
    });

    const verified = await auth.verifyToken(token);
    expect(verified.mentraUserId).toBe("user_123");
  });

  test("extractBearerToken accepts Bearer auth and rejects missing auth", () => {
    expect(extractBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(() => extractBearerToken(undefined)).toThrow(MentraAuthError);
  });

  test("mentraJwksUrl defaults to the production Core JWKS endpoint", () => {
    expect(mentraJwksUrl()).toBe("https://core.mentraglass.com/.well-known/jwks.json");
  });

  test("hono middleware verifies auth and sets the context variable", async () => {
    const token = await mintMiniappToken(TEST_PACKAGE);
    const auth = createMentraAuth({
      packageName: TEST_PACKAGE,
      jwksUrl: `${server.url.origin}/.well-known/jwks.json`,
    });
    const values = new Map<string, unknown>();
    const middleware = auth.hono();

    await middleware(
      {
        req: { header: () => `Bearer ${token}` },
        set: (key, value) => values.set(key, value),
        json: (body, status = 200) => Response.json(body, { status }),
      },
      async () => {},
    );

    expect((values.get("mentraAuth") as { mentraUserId: string }).mentraUserId).toBe("user_123");
  });
});

async function mintMiniappToken(
  audience: string,
  opts: { issuer?: string } = {},
): Promise<string> {
  const privateKey = await jose.importPKCS8(privatePem, "EdDSA");
  return new jose.SignJWT({ oemId: "test-oem" })
    .setProtectedHeader({ alg: "EdDSA", kid: "mentra-miniapp-1" })
    .setIssuer(opts.issuer ?? TEST_ISSUER)
    .setAudience(audience)
    .setSubject("user_123")
    .setJti("token_123")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}
