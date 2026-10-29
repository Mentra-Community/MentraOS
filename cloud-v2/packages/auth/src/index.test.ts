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
// Core's key set publishes keys for several token types, some under the same
// key material; the sign-in server's kid stands in for them here.
const jwks = {
  keys: [
    { ...publicJwk, alg: "EdDSA", use: "sig", kid: "mentra-miniapp-1" },
    { ...publicJwk, alg: "EdDSA", use: "sig", kid: "mentra-oidc-1" },
  ],
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

// Four more Cores, each with its own key under the same `kid`: the hosted prod,
// staging and dev environments, and the Core of a Private Cloud.
const prodCore = await startCore();
const stagingCore = await startCore();
const devCore = await startCore();
const privateCore = await startCore();

// A guaranteed-unreachable endpoint (port 1) used to prove that a successful or
// claim-rejected verification never fetches later endpoints in the list.
const UNREACHABLE_JWKS_URL = "http://127.0.0.1:1/.well-known/jwks.json";

afterAll(() => {
  server.stop(true);
  serverB.stop(true);
  for (const core of [prodCore, stagingCore, devCore, privateCore]) core.server.stop(true);
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

  test("exposes the verified account email and ignores an unverified one", async () => {
    const auth = createMentraAuth({
      packageName: TEST_PACKAGE,
      jwksUrl: `${server.url.origin}/.well-known/jwks.json`,
    });

    const verified = await auth.verifyToken(
      await mintMiniappToken(TEST_PACKAGE, { claims: { email: "wearer@example.com", email_verified: true } }),
    );
    expect(verified.email).toBe("wearer@example.com");
    expect(verified.mentraUserId).toBe("user_123");

    const unverified = await auth.verifyToken(
      await mintMiniappToken(TEST_PACKAGE, { claims: { email: "wearer@example.com", email_verified: false } }),
    );
    expect(unverified.email).toBeUndefined();

    const absent = await auth.verifyToken(await mintMiniappToken(TEST_PACKAGE));
    expect(absent.email).toBeUndefined();
    expect("email" in absent).toBe(false);
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

describe("token type and key pinning", () => {
  const urlA = `${server.url.origin}/.well-known/jwks.json`;
  test("a token under another Core key ID is refused, even with a valid signature and claims", async () => {
    const token = await mintWithKey(privatePem, TEST_PACKAGE, { kid: "mentra-oidc-1" });
    const auth = createMentraAuth({ packageName: TEST_PACKAGE, jwksUrl: urlA });
    await expect(auth.verifyToken(token)).rejects.toThrow("unexpected key ID");
  });

  test("a typed at+jwt token is refused", async () => {
    const privateKey = await jose.importPKCS8(privatePem, "EdDSA");
    const token = await new jose.SignJWT({ tenantId: "test-oem" })
      .setProtectedHeader({ alg: "EdDSA", kid: "mentra-miniapp-1", typ: "at+jwt" })
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_PACKAGE)
      .setSubject("user_123")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
    const auth = createMentraAuth({ packageName: TEST_PACKAGE, jwksUrl: urlA });
    await expect(auth.verifyToken(token)).rejects.toThrow("unexpected token type");
  });

  test.each([1, {}])("a non-string typ (%p) is refused, never a TypeError", async (typ) => {
    const privateKey = await jose.importPKCS8(privatePem, "EdDSA");
    const token = await new jose.SignJWT({ tenantId: "test-oem" })
      .setProtectedHeader({ alg: "EdDSA", kid: "mentra-miniapp-1", typ } as unknown as jose.JWTHeaderParameters)
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_PACKAGE)
      .setSubject("user_123")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
    const auth = createMentraAuth({ packageName: TEST_PACKAGE, jwksUrl: urlA });
    await expect(auth.verifyToken(token)).rejects.toThrow("unexpected token type");
  });

  test("keyIds widens the accepted key IDs for a rotation", async () => {
    const token = await mintWithKey(privatePem, TEST_PACKAGE, { kid: "mentra-oidc-1" });
    const auth = createMentraAuth({ packageName: TEST_PACKAGE, jwksUrl: urlA, keyIds: ["mentra-miniapp-1", "mentra-oidc-1"] });
    await expect(auth.verifyToken(token)).resolves.toMatchObject({ mentraUserId: "user_b" });
  });
});

describe("miniapp token features", () => {
  // The key sets a backend shared across environments trusts by default.
  const hostedUrls = [prodCore.jwksUrl, stagingCore.jwksUrl, devCore.jwksUrl];
  const FEATURES = ["call.unlimited", "notes.pro"];

  test.each([
    ["prod", prodCore],
    ["staging", stagingCore],
    ["dev", devCore],
  ] as const)("keeps the features of a %s token and answers hasFeature", async (_name, core) => {
    const auth = createMentraAuth({ packageName: TEST_PACKAGE, jwksUrls: hostedUrls });

    const verified = await auth.verifyToken(await mintCoreToken(core, { features: FEATURES }));

    expect(verified.features).toEqual(FEATURES);
    expect(verified.hasFeature("call.unlimited")).toBe(true);
    expect(verified.hasFeature("notes.pro")).toBe(true);
    expect(verified.hasFeature("call.other")).toBe(false);
    expect(verified.hasFeature("CALL.UNLIMITED")).toBe(false);
    expect(verified.hasFeature("call")).toBe(false);
  });

  test("a backend configured by MENTRA_AUTH_JWKS_URLS honors the features of every listed Core", async () => {
    await withEnv({ MENTRA_AUTH_JWKS_URLS: hostedUrls.join(",") }, async () => {
      const auth = createMentraAuth({ packageName: TEST_PACKAGE });
      for (const core of [prodCore, stagingCore, devCore]) {
        const verified = await auth.verifyToken(await mintCoreToken(core, { features: FEATURES }));
        expect(verified.hasFeature("call.unlimited")).toBe(true);
      }
      await expect(
        auth.verifyToken(await mintCoreToken(privateCore, { features: FEATURES })),
      ).rejects.toBeInstanceOf(MentraAuthError);
    });
  });

  test("a Private Cloud backend honors its own Core's features and refuses a hosted Core's token", async () => {
    const auth = createMentraAuth({ packageName: TEST_PACKAGE, jwksUrl: privateCore.jwksUrl });

    const own = await auth.verifyToken(await mintCoreToken(privateCore, { features: FEATURES }));
    expect(own.features).toEqual(FEATURES);
    expect(own.hasFeature("call.unlimited")).toBe(true);

    for (const hosted of [prodCore, stagingCore, devCore]) {
      await expect(
        auth.verifyToken(await mintCoreToken(hosted, { features: FEATURES })),
      ).rejects.toBeInstanceOf(MentraAuthError);
    }
  });

  test("a Private Cloud backend configured by MENTRA_AUTH_JWKS_URL honors only that Core", async () => {
    await withEnv({ MENTRA_AUTH_JWKS_URL: privateCore.jwksUrl }, async () => {
      const auth = createMentraAuth({ packageName: TEST_PACKAGE });

      const own = await auth.verifyToken(await mintCoreToken(privateCore, { features: FEATURES }));
      expect(own.hasFeature("call.unlimited")).toBe(true);
      await expect(
        auth.verifyToken(await mintCoreToken(prodCore, { features: FEATURES })),
      ).rejects.toBeInstanceOf(MentraAuthError);
    });
  });

  test("a backend that trusts the hosted key sets refuses a Private Cloud Core's token", async () => {
    const auth = createMentraAuth({ packageName: TEST_PACKAGE, jwksUrls: hostedUrls });

    await expect(
      auth.verifyToken(await mintCoreToken(privateCore, { features: FEATURES })),
    ).rejects.toBeInstanceOf(MentraAuthError);
  });

  test.each([
    ["no claim", undefined],
    ["an empty list", []],
    ["a string", "call.unlimited"],
    ["an object", { "call.unlimited": true }],
    ["null", null],
    ["a number", 1],
    ["only non-string entries", [1, null, {}]],
    ["a mix of string and non-string entries", ["call.unlimited", 1]],
  ] as const)("a token with %s yields no features", async (_name, claim) => {
    const auth = createMentraAuth({ packageName: TEST_PACKAGE, jwksUrls: hostedUrls });

    const verified = await auth.verifyToken(await mintCoreToken(prodCore, { features: claim }));

    expect(verified.features).toEqual([]);
    expect(verified.hasFeature("call.unlimited")).toBe(false);
  });

  test("hasFeature answers from the verified claim, however the caller uses the result", async () => {
    const auth = createMentraAuth({ packageName: TEST_PACKAGE, jwksUrls: hostedUrls });
    const verified = await auth.verifyToken(await mintCoreToken(prodCore, { features: FEATURES }));

    const { hasFeature } = verified;
    expect(hasFeature("call.unlimited")).toBe(true);

    verified.features.push("call.premium");
    verified.features.length = 0;
    expect(verified.hasFeature("call.unlimited")).toBe(true);
    expect(verified.hasFeature("call.premium")).toBe(false);
    expect(verified.claims.features).toEqual(FEATURES);
  });

  test("the hono middleware exposes hasFeature on the context variable", async () => {
    const auth = createMentraAuth({ packageName: TEST_PACKAGE, jwksUrls: hostedUrls });
    const token = await mintCoreToken(devCore, { features: FEATURES });
    const values = new Map<string, unknown>();

    await auth.hono()(
      {
        req: { header: () => `Bearer ${token}` },
        set: (key, value) => values.set(key, value),
        json: (body, status = 200) => Response.json(body, { status }),
      },
      async () => {},
    );

    const session = values.get("mentraAuth") as { hasFeature(feature: string): boolean };
    expect(session.hasFeature("call.unlimited")).toBe(true);
    expect(session.hasFeature("call.other")).toBe(false);
  });

  test("features do not change what verification returns or accepts", async () => {
    const auth = createMentraAuth({ packageName: TEST_PACKAGE, jwksUrls: hostedUrls });

    const verified = await auth.verifyToken(await mintCoreToken(stagingCore, { features: FEATURES }));
    expect(verified).toMatchObject({
      mentraUserId: "user_core",
      tenantId: "test-oem",
      packageName: TEST_PACKAGE,
      tokenId: "token_core",
    });
    expect(verified.expiresAt).toBeNumber();
    expect(verified.issuedAt).toBeNumber();
    expect(verified.email).toBeUndefined();

    // A token that carries features is still refused for any other reason.
    await expect(
      auth.verifyToken(await mintCoreToken(prodCore, { features: FEATURES, audience: "com.other.app" })),
    ).rejects.toBeInstanceOf(MentraAuthError);
    await expect(
      auth.verifyToken(await mintCoreToken(prodCore, { features: FEATURES, kid: "mentra-oidc-1" })),
    ).rejects.toThrow("unexpected key ID");
    await expect(
      auth.verifyToken(await mintCoreToken(prodCore, { features: FEATURES, issuer: "someone-else" })),
    ).rejects.toBeInstanceOf(MentraAuthError);
    await expect(
      auth.verifyToken(
        await mintCoreToken(prodCore, { features: FEATURES, expirationTime: Math.floor(Date.now() / 1000) - 600 }),
      ),
    ).rejects.toThrow("miniapp token rejected");
  });
});

interface TestCore {
  server: ReturnType<typeof Bun.serve>;
  jwksUrl: string;
  privatePem: string;
}

/** A local Core: its own Ed25519 key, published at /.well-known/jwks.json as `mentra-miniapp-1`. */
async function startCore(): Promise<TestCore> {
  const pair = crypto.generateKeyPairSync("ed25519");
  const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicJwk = await jose.exportJWK(
    await jose.importSPKI(pair.publicKey.export({ type: "spki", format: "pem" }).toString(), "EdDSA", {
      extractable: true,
    }),
  );
  const keys = { keys: [{ ...publicJwk, alg: "EdDSA", use: "sig", kid: "mentra-miniapp-1" }] };
  const coreServer = Bun.serve({
    port: 0,
    fetch(request) {
      return new URL(request.url).pathname === "/.well-known/jwks.json"
        ? Response.json(keys)
        : new Response("not found", { status: 404 });
    },
  });
  return { server: coreServer, jwksUrl: `${coreServer.url.origin}/.well-known/jwks.json`, privatePem: pem };
}

/** Mint a miniapp token as `core` would, optionally carrying a `features` claim of any shape. */
async function mintCoreToken(
  core: TestCore,
  opts: { features?: unknown; audience?: string; kid?: string; issuer?: string; expirationTime?: string | number } = {},
): Promise<string> {
  const privateKey = await jose.importPKCS8(core.privatePem, "EdDSA");
  return new jose.SignJWT({
    tenantId: "test-oem",
    ...(opts.features === undefined ? {} : { features: opts.features }),
  } as jose.JWTPayload)
    .setProtectedHeader({ alg: "EdDSA", kid: opts.kid ?? "mentra-miniapp-1" })
    .setIssuer(opts.issuer ?? TEST_ISSUER)
    .setAudience(opts.audience ?? TEST_PACKAGE)
    .setSubject("user_core")
    .setJti("token_core")
    .setIssuedAt()
    .setExpirationTime(opts.expirationTime ?? "1h")
    .sign(privateKey);
}

/** Run `fn` with these environment variables set, restoring the previous values after. */
async function withEnv(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const names = ["MENTRA_AUTH_JWKS_URL", "MENTRA_AUTH_JWKS_URLS"];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  Object.assign(process.env, vars);
  try {
    await fn();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function mintMiniappToken(
  audience: string,
  opts: { expirationTime?: string | number; issuer?: string; claims?: jose.JWTPayload } = {},
): Promise<string> {
  const privateKey = await jose.importPKCS8(privatePem, "EdDSA");
  return new jose.SignJWT({ tenantId: "test-oem", ...opts.claims })
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
