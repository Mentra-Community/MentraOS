import crypto from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import * as jose from "jose";

import {
  MENTRA_JWKS_URLS,
  MentraAuthError,
  createMentraAuth,
  extractBearerToken,
  mentraJwksUrl,
  mentraJwksUrls,
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

// A second Mentra environment: the SAME `kid` with DIFFERENT key material. This
// reproduces the real cross-environment collision (prod/staging/dev/debug all use
// kid "mentra-miniapp-1" but distinct keys).
const keypairB = crypto.generateKeyPairSync("ed25519");
const privatePemB = keypairB.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicPemB = keypairB.publicKey.export({ type: "spki", format: "pem" }).toString();
const publicKeyB = await jose.importSPKI(publicPemB, "EdDSA", { extractable: true });
const publicJwkB = await jose.exportJWK(publicKeyB);
const jwksB = {
  keys: [{ ...publicJwkB, alg: "EdDSA", use: "sig", kid: "mentra-miniapp-1" }],
};

const serverB = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/.well-known/jwks.json") {
      return Response.json(jwksB);
    }
    return new Response("not found", { status: 404 });
  },
});

// A guaranteed-unreachable endpoint (port 1) used to prove that a successful or
// claim-rejected verification never fetches later endpoints in the list.
const UNREACHABLE_JWKS_URL = "http://127.0.0.1:1/.well-known/jwks.json";

afterAll(() => {
  server.stop(true);
  serverB.stop(true);
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
    expect(verified.tenantId).toBe("test-oem");
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

  test("rejects expired miniapp tokens", async () => {
    const token = await mintMiniappToken(TEST_PACKAGE, {
      expirationTime: Math.floor(Date.now() / 1000) - 60,
    });
    const auth = createMentraAuth({
      packageName: TEST_PACKAGE,
      jwksUrl: `${server.url.origin}/.well-known/jwks.json`,
      clockTolerance: 0,
    });

    await expect(auth.verifyToken(token)).rejects.toThrow(MentraAuthError);
    await expect(auth.verifyToken(token)).rejects.toThrow("miniapp token rejected");
  });

  test("rejects tokens signed with an unexpected algorithm", async () => {
    const token = await new jose.SignJWT({ oemId: "test-oem" })
      .setProtectedHeader({ alg: "HS256", kid: "mentra-miniapp-1" })
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_PACKAGE)
      .setSubject("user_123")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("not-the-eddsa-key"));
    const auth = createMentraAuth({
      packageName: TEST_PACKAGE,
      jwksUrl: `${server.url.origin}/.well-known/jwks.json`,
    });

    await expect(auth.verifyToken(token)).rejects.toBeInstanceOf(MentraAuthError);
  });

  test("rejects tampered tokens", async () => {
    const token = await mintMiniappToken(TEST_PACKAGE);
    const parts = token.split(".");
    parts[1] = parts[1]!.replace(/.$/, parts[1]!.endsWith("A") ? "B" : "A");
    const tampered = parts.join(".");
    const auth = createMentraAuth({
      packageName: TEST_PACKAGE,
      jwksUrl: `${server.url.origin}/.well-known/jwks.json`,
    });

    await expect(auth.verifyToken(tampered)).rejects.toBeInstanceOf(MentraAuthError);
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

describe("@mentra/auth multi-environment JWKS fallback", () => {
  const urlA = `${server.url.origin}/.well-known/jwks.json`;
  const urlB = `${serverB.url.origin}/.well-known/jwks.json`;

  test("falls through to the environment that signed the token (same kid, different key)", async () => {
    const token = await mintWithKey(privatePemB, TEST_PACKAGE);
    const auth = createMentraAuth({ packageName: TEST_PACKAGE, jwksUrls: [urlA, urlB] });

    const verified = await auth.verifyToken(token);

    expect(verified.mentraUserId).toBe("user_b");
  });

  test("verifies against the first environment without fetching later ones", async () => {
    const token = await mintMiniappToken(TEST_PACKAGE); // signed by env A
    // env A is first; the unreachable URL second would error if it were ever fetched.
    const auth = createMentraAuth({
      packageName: TEST_PACKAGE,
      jwksUrls: [urlA, UNREACHABLE_JWKS_URL],
      timeoutMs: 1_000,
    });

    const verified = await auth.verifyToken(token);

    expect(verified.mentraUserId).toBe("user_123");
  });

  test("a claim failure on the matching environment is not retried across others", async () => {
    const token = await mintWithKey(privatePemB, TEST_PACKAGE, {
      expirationTime: Math.floor(Date.now() / 1000) - 60,
    });
    // env B signs and is in the middle; if expiry were mistaken for a key mismatch,
    // verification would reach the unreachable URL and fail with a fetch error instead.
    const auth = createMentraAuth({
      packageName: TEST_PACKAGE,
      jwksUrls: [urlA, urlB, UNREACHABLE_JWKS_URL],
      clockTolerance: 0,
      timeoutMs: 1_000,
    });

    await expect(auth.verifyToken(token)).rejects.toThrow(/exp/i);
  });

  test("rejects when no environment holds the key", async () => {
    const token = await mintWithKey(privatePemB, TEST_PACKAGE, { kid: "unknown-kid-9" });
    const auth = createMentraAuth({ packageName: TEST_PACKAGE, jwksUrls: [urlA, urlB] });

    await expect(auth.verifyToken(token)).rejects.toBeInstanceOf(MentraAuthError);
  });

  test("an explicit single jwksUrl disables fallback", async () => {
    const token = await mintMiniappToken(TEST_PACKAGE); // signed by env A
    // Point only at env B: with fallback disabled, the env A token must be rejected.
    const auth = createMentraAuth({ packageName: TEST_PACKAGE, jwksUrl: urlB });

    await expect(auth.verifyToken(token)).rejects.toBeInstanceOf(MentraAuthError);
  });

  test("defaults to the full ordered Mentra environment list", () => {
    expect(mentraJwksUrls()).toEqual(MENTRA_JWKS_URLS);
    expect(mentraJwksUrls()).toHaveLength(4);
    expect(mentraJwksUrl()).toBe(MENTRA_JWKS_URLS[0]);
  });
});

async function mintMiniappToken(
  audience: string,
  opts: { expirationTime?: string | number; issuer?: string } = {},
): Promise<string> {
  const privateKey = await jose.importPKCS8(privatePem, "EdDSA");
  return new jose.SignJWT({ tenantId: "test-oem" })
    .setProtectedHeader({ alg: "EdDSA", kid: "mentra-miniapp-1" })
    .setIssuer(opts.issuer ?? TEST_ISSUER)
    .setAudience(audience)
    .setSubject("user_123")
    .setJti("token_123")
    .setIssuedAt()
    .setExpirationTime(opts.expirationTime ?? "1h")
    .sign(privateKey);
}

async function mintWithKey(
  privatePemArg: string,
  audience: string,
  opts: { kid?: string; expirationTime?: string | number } = {},
): Promise<string> {
  const privateKey = await jose.importPKCS8(privatePemArg, "EdDSA");
  return new jose.SignJWT({ tenantId: "test-oem" })
    .setProtectedHeader({ alg: "EdDSA", kid: opts.kid ?? "mentra-miniapp-1" })
    .setIssuer(TEST_ISSUER)
    .setAudience(audience)
    .setSubject("user_b")
    .setJti("token_b")
    .setIssuedAt()
    .setExpirationTime(opts.expirationTime ?? "1h")
    .sign(privateKey);
}
