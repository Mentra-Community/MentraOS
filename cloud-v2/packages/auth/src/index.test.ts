import crypto from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import * as jose from "jose";

import {
  LEGACY_CORE_ISSUER,
  MENTRA_JWKS_URLS,
  MentraAuthError,
  createMentraAuth,
  extractBearerToken,
  mentraJwksUrl,
  mentraJwksUrls,
  mentraSignInChallenge,
  verifyMentraToken,
  type HonoLikeContext,
  type MentraAuth,
  type MentraAuthOptions,
  type MentraMiniappFilesOptions,
  type VerifiedMentraAuth,
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

describe("Core binding", () => {
  const origin = (core: TestCore) => core.server.url.origin;
  const configurationError = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(MentraAuthError);
      return (error as MentraAuthError).code;
    }
    throw new Error("expected a configuration error");
  };

  test("accepts a token whose issuer names the bound Core", async () => {
    const auth = createMentraAuth({ packageName: TEST_PACKAGE, coreUrl: origin(prodCore) });
    const verified = await auth.verifyToken(await mintCoreToken(prodCore, { issuer: origin(prodCore) }));
    expect(verified.mentraUserId).toBe("user_core");
    expect(auth.coreUrl).toBe(origin(prodCore));
  });

  test("accepts the legacy issuer from the bound Core's own key set", async () => {
    const auth = createMentraAuth({ packageName: TEST_PACKAGE, coreUrl: origin(prodCore) });
    const verified = await auth.verifyToken(await mintCoreToken(prodCore, { issuer: LEGACY_CORE_ISSUER }));
    expect(verified.mentraUserId).toBe("user_core");
  });

  test("derives the key set from the Core URL, and normalizes it to its origin", () => {
    expect(mentraJwksUrls({ coreUrl: `${origin(devCore)}/` })).toEqual([devCore.jwksUrl]);
    expect(createMentraAuth({ packageName: TEST_PACKAGE, coreUrl: ` ${origin(devCore)}/ ` }).coreUrl).toBe(
      origin(devCore),
    );
  });

  test("rejects another Core's token, whatever issuer it names", async () => {
    const auth = createMentraAuth({ packageName: TEST_PACKAGE, coreUrl: origin(prodCore) });
    for (const issuer of [origin(devCore), origin(prodCore), LEGACY_CORE_ISSUER]) {
      await expect(auth.verifyToken(await mintCoreToken(devCore, { issuer }))).rejects.toBeInstanceOf(MentraAuthError);
    }
  });

  test("rejects the bound Core's token when it names another Core", async () => {
    const auth = createMentraAuth({ packageName: TEST_PACKAGE, coreUrl: origin(prodCore) });
    for (const issuer of [origin(stagingCore), "https://core.mentraglass.com.evil.example", "mentra"]) {
      await expect(auth.verifyToken(await mintCoreToken(prodCore, { issuer }))).rejects.toThrow(/iss/);
    }
  });

  test("reads MENTRA_CORE_URL, and the option wins over it", async () => {
    await withEnv({ MENTRA_CORE_URL: origin(stagingCore) }, async () => {
      const fromEnv = createMentraAuth({ packageName: TEST_PACKAGE });
      expect(fromEnv.coreUrl).toBe(origin(stagingCore));
      expect(mentraJwksUrls()).toEqual([stagingCore.jwksUrl]);
      await expect(
        fromEnv.verifyToken(await mintCoreToken(stagingCore, { issuer: origin(stagingCore) })),
      ).resolves.toMatchObject({ mentraUserId: "user_core" });
      await expect(
        fromEnv.verifyToken(await mintCoreToken(prodCore, { issuer: origin(prodCore) })),
      ).rejects.toBeInstanceOf(MentraAuthError);

      const fromOption = createMentraAuth({ packageName: TEST_PACKAGE, coreUrl: origin(prodCore) });
      expect(fromOption.coreUrl).toBe(origin(prodCore));
    });
  });

  test("refuses to combine a binding with the settings it replaces", async () => {
    const coreUrl = origin(prodCore);
    for (const options of [{ jwksUrl: devCore.jwksUrl }, { jwksUrls: [devCore.jwksUrl] }, { issuer: "cloud-core" }]) {
      expect(configurationError(() => createMentraAuth({ packageName: TEST_PACKAGE, coreUrl, ...options }))).toBe(
        "invalid_configuration",
      );
    }
    for (const name of ["MENTRA_AUTH_JWKS_URLS", "MENTRA_AUTH_JWKS_URL", "MENTRA_AUTH_ISSUERS", "MENTRA_AUTH_ISSUER"]) {
      await withEnv({ MENTRA_CORE_URL: coreUrl, [name]: "cloud-core" }, async () => {
        expect(() => createMentraAuth({ packageName: TEST_PACKAGE })).toThrow(name);
      });
    }
  });

  test("refuses a Core URL that isn't an origin", () => {
    for (const coreUrl of ["core.mentraglass.com", "https://core.mentraglass.com/api", "https://core.mentraglass.com/?x", "ftp://core.mentraglass.com"]) {
      expect(configurationError(() => createMentraAuth({ packageName: TEST_PACKAGE, coreUrl }))).toBe(
        "invalid_configuration",
      );
    }
  });

  test("requireCoreUrl refuses to start unbound, and is met by MENTRA_CORE_URL", async () => {
    await withEnv({ MENTRA_AUTH_JWKS_URLS: MENTRA_JWKS_URLS.join(",") }, async () => {
      expect(() => createMentraAuth({ packageName: TEST_PACKAGE, requireCoreUrl: true })).toThrow("MENTRA_CORE_URL");
    });
    await withEnv({ MENTRA_CORE_URL: origin(prodCore) }, async () => {
      expect(createMentraAuth({ packageName: TEST_PACKAGE, requireCoreUrl: true }).coreUrl).toBe(origin(prodCore));
    });
  });

  test("leaves an unbound verifier as it was: explicit lists, env lists and the all-Cores default", async () => {
    const explicit = createMentraAuth({ packageName: TEST_PACKAGE, jwksUrls: [prodCore.jwksUrl, devCore.jwksUrl] });
    expect(explicit.coreUrl).toBeUndefined();
    await expect(explicit.verifyToken(await mintCoreToken(devCore))).resolves.toMatchObject({ mentraUserId: "user_core" });
    // Each key set also accepts its own Core's name, so a Core that names itself breaks no unbound verifier,
    // while a token never passes under another Core's name.
    await expect(
      explicit.verifyToken(await mintCoreToken(devCore, { issuer: origin(devCore) })),
    ).resolves.toMatchObject({ mentraUserId: "user_core" });
    await expect(explicit.verifyToken(await mintCoreToken(devCore, { issuer: origin(prodCore) }))).rejects.toThrow(/iss/);
    const listed = createMentraAuth({ packageName: TEST_PACKAGE, jwksUrls: [prodCore.jwksUrl], issuer: ["cloud-core", "mentra"] });
    await expect(
      listed.verifyToken(await mintCoreToken(prodCore, { issuer: origin(prodCore) })),
    ).resolves.toMatchObject({ mentraUserId: "user_core" });
    await expect(listed.verifyToken(await mintCoreToken(prodCore, { issuer: "https://elsewhere.example" }))).rejects.toThrow(/iss/);
    await withEnv({ MENTRA_AUTH_JWKS_URLS: `${stagingCore.jwksUrl},${devCore.jwksUrl}` }, async () => {
      expect(mentraJwksUrls()).toEqual([stagingCore.jwksUrl, devCore.jwksUrl]);
    });
    await withEnv({}, async () => {
      expect(mentraJwksUrls()).toEqual(MENTRA_JWKS_URLS);
    });
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

describe("workspace and local-build claims", () => {
  const jwksUrl = `${server.url.origin}/.well-known/jwks.json`;

  test("surfaces the workspace a Fleet-assigned token names", async () => {
    const auth = createMentraAuth({ packageName: TEST_PACKAGE, jwksUrl });

    const verified = await auth.verifyToken(await mintMiniappToken(TEST_PACKAGE, { claims: { workspaceId: "ws_123" } }));

    expect(verified.workspaceId).toBe("ws_123");
    expect(verified.localBuild).toBe(false);
  });

  test.each(["member", "developer", "admin", "owner"] as const)("surfaces the %s role beside the workspace", async (role) => {
    const auth = createMentraAuth({ packageName: TEST_PACKAGE, jwksUrl });

    const verified = await auth.verifyToken(
      await mintMiniappToken(TEST_PACKAGE, { claims: { workspaceId: "ws_123", workspaceRole: role } }),
    );

    expect(verified.workspaceId).toBe("ws_123");
    expect(verified.workspaceRole).toBe(role);
  });

  test.each([
    ["no role claim (an older Core)", { workspaceId: "ws_123" }],
    ["a role this library doesn't know", { workspaceId: "ws_123", workspaceRole: "superuser" }],
    ["a role that is not a string", { workspaceId: "ws_123", workspaceRole: ["owner"] }],
    ["a role without a workspace", { workspaceRole: "owner" }],
  ] as const)("a token with %s gives no role", async (_name, claims) => {
    const auth = createMentraAuth({ packageName: TEST_PACKAGE, jwksUrl });

    const verified = await auth.verifyToken(await mintMiniappToken(TEST_PACKAGE, { claims }));

    expect(verified.workspaceRole).toBeNull();
  });

  test("a website's token names the website; the phone's names none", async () => {
    const auth = createMentraAuth({ packageName: TEST_PACKAGE, jwksUrl });

    const fromWebsite = await auth.verifyToken(await mintMiniappToken(TEST_PACKAGE, { claims: { client_id: "mwc_01hzy3v8n0f2e9gq4t6kxh5rd0" } }));
    expect(fromWebsite.clientId).toBe("mwc_01hzy3v8n0f2e9gq4t6kxh5rd0");

    const fromPhone = await auth.verifyToken(await mintMiniappToken(TEST_PACKAGE));
    expect(fromPhone.clientId).toBeNull();
    // Anything but a non-empty string is no website.
    for (const client_id of ["", 7, ["mwc_x"], null]) {
      expect((await auth.verifyToken(await mintMiniappToken(TEST_PACKAGE, { claims: { client_id } }))).clientId).toBeNull();
    }
  });

  test("a local build never holds a role, even if its token carries one", async () => {
    const auth = createMentraAuth({ packageName: TEST_PACKAGE, jwksUrl, allowLocalBuilds: true });

    const verified = await auth.verifyToken(
      await mintMiniappToken(TEST_PACKAGE, { claims: { localBuild: true, workspaceId: "ws_123", workspaceRole: "owner" } }),
    );

    expect(verified.workspaceId).toBeNull();
    expect(verified.workspaceRole).toBeNull();
  });

  test.each([
    ["no claim", undefined],
    ["an empty string", ""],
    ["a number", 7],
    ["a list", ["ws_123"]],
    ["null", null],
  ] as const)("a token with %s for workspaceId names no workspace", async (_name, claim) => {
    const auth = createMentraAuth({ packageName: TEST_PACKAGE, jwksUrl });
    const claims = claim === undefined ? {} : { workspaceId: claim };

    const verified = await auth.verifyToken(await mintMiniappToken(TEST_PACKAGE, { claims }));

    expect(verified.workspaceId).toBeNull();
  });

  test("an ordinary token, and one marked localBuild false, is not a local build", async () => {
    const auth = createMentraAuth({ packageName: TEST_PACKAGE, jwksUrl });

    expect((await auth.verifyToken(await mintMiniappToken(TEST_PACKAGE))).localBuild).toBe(false);
    expect(
      (await auth.verifyToken(await mintMiniappToken(TEST_PACKAGE, { claims: { localBuild: false } }))).localBuild,
    ).toBe(false);
  });

  test("a local-build token is refused by default", async () => {
    await withEnv({}, async () => {
      const auth = createMentraAuth({ packageName: TEST_PACKAGE, jwksUrl });
      const token = await mintMiniappToken(TEST_PACKAGE, { claims: { localBuild: true } });

      const error = await auth.verifyToken(token).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(MentraAuthError);
      expect((error as MentraAuthError).code).toBe("local_build_not_allowed");
      await expect(verifyMentraToken(token, { packageName: TEST_PACKAGE, jwksUrl })).rejects.toThrow(
        "local build",
      );
    });
  });

  test("allowLocalBuilds accepts a local-build token and marks it", async () => {
    const auth = createMentraAuth({ packageName: TEST_PACKAGE, jwksUrl, allowLocalBuilds: true });

    const verified = await auth.verifyToken(await mintMiniappToken(TEST_PACKAGE, { claims: { localBuild: true } }));

    expect(verified.localBuild).toBe(true);
    expect(verified.mentraUserId).toBe("user_123");
    expect(verified.workspaceId).toBeNull();
  });

  test("a local build never names a workspace, even if its token carries one", async () => {
    const auth = createMentraAuth({ packageName: TEST_PACKAGE, jwksUrl, allowLocalBuilds: true });

    const verified = await auth.verifyToken(
      await mintMiniappToken(TEST_PACKAGE, { claims: { localBuild: true, workspaceId: "ws_123" } }),
    );

    expect(verified.localBuild).toBe(true);
    expect(verified.workspaceId).toBeNull();
  });

  test.each([
    ["a string", "true"],
    ["a number", 1],
    ["null", null],
    ["an object", {}],
  ] as const)("a token with %s for localBuild is read as a local build", async (_name, claim) => {
    await withEnv({}, async () => {
      const token = await mintMiniappToken(TEST_PACKAGE, { claims: { localBuild: claim } });

      await expect(createMentraAuth({ packageName: TEST_PACKAGE, jwksUrl }).verifyToken(token)).rejects.toThrow(
        "local build",
      );
      const allowed = await createMentraAuth({ packageName: TEST_PACKAGE, jwksUrl, allowLocalBuilds: true }).verifyToken(
        token,
      );
      expect(allowed.localBuild).toBe(true);
    });
  });

  test("MENTRA_AUTH_ALLOW_LOCAL_BUILDS=true allows local builds, and the option overrides it", async () => {
    const token = await mintMiniappToken(TEST_PACKAGE, { claims: { localBuild: true } });

    await withEnv({ MENTRA_AUTH_ALLOW_LOCAL_BUILDS: "true" }, async () => {
      const verified = await createMentraAuth({ packageName: TEST_PACKAGE, jwksUrl }).verifyToken(token);
      expect(verified.localBuild).toBe(true);
      await expect(
        createMentraAuth({ packageName: TEST_PACKAGE, jwksUrl, allowLocalBuilds: false }).verifyToken(token),
      ).rejects.toThrow("local build");
    });
    await withEnv({ MENTRA_AUTH_ALLOW_LOCAL_BUILDS: " TRUE " }, async () => {
      const verified = await createMentraAuth({ packageName: TEST_PACKAGE, jwksUrl }).verifyToken(token);
      expect(verified.localBuild).toBe(true);
    });
  });

  test.each(["false", "1", "yes", "on", ""])(
    "MENTRA_AUTH_ALLOW_LOCAL_BUILDS=%p leaves local builds refused",
    async (value) => {
      const token = await mintMiniappToken(TEST_PACKAGE, { claims: { localBuild: true } });
      await withEnv({ MENTRA_AUTH_ALLOW_LOCAL_BUILDS: value }, async () => {
        await expect(createMentraAuth({ packageName: TEST_PACKAGE, jwksUrl }).verifyToken(token)).rejects.toThrow(
          "local build",
        );
      });
    },
  );

  test("the hono middleware refuses a local-build token with its error code", async () => {
    await withEnv({}, async () => {
      const auth = createMentraAuth({ packageName: TEST_PACKAGE, jwksUrl });
      const token = await mintMiniappToken(TEST_PACKAGE, { claims: { localBuild: true } });
      let seen: MentraAuthError | undefined;
      let nextCalled = false;

      const response = await auth.hono({
        onUnauthorized: (error, c) => {
          seen = error;
          return c.json({ error: error.code }, 401);
        },
      })(fakeContext(`Bearer ${token}`).c, async () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(false);
      expect((response as Response).status).toBe(401);
      expect(seen?.code).toBe("local_build_not_allowed");
    });
  });

  test("errors carry a code for a missing token and a rejected one", async () => {
    const auth = createMentraAuth({ packageName: TEST_PACKAGE, jwksUrl });

    expect(() => extractBearerToken(undefined)).toThrow(expect.objectContaining({ code: "missing_token" }));
    await expect(auth.verifyAuthHeader("Basic abc")).rejects.toMatchObject({ code: "missing_token" });
    await expect(auth.verifyToken("not-a-jwt")).rejects.toMatchObject({ code: "invalid_token" });
    await expect(auth.verifyToken(await mintMiniappToken("com.other.app"))).rejects.toMatchObject({
      code: "invalid_token",
    });
    expect(new MentraAuthError("legacy").code).toBe("invalid_token");
  });
});

describe("miniappFiles: the sign-in challenge", () => {
  const jwksUrl = `${server.url.origin}/.well-known/jwks.json`;
  const CHALLENGE = `Bearer realm="mentra", package="${TEST_PACKAGE}"`;
  const allowAll = () => true;
  const files = (options: MentraAuthOptions = {}) => createMentraAuth({ packageName: TEST_PACKAGE, jwksUrl, ...options });

  test("the challenge is exactly the Mentra realm and the package", () => {
    expect(mentraSignInChallenge("com.acme.tools")).toBe('Bearer realm="mentra", package="com.acme.tools"');
  });

  test.each([
    ["no Authorization header", undefined],
    ["an empty Authorization header", ""],
    ["another scheme", "Basic dXNlcjpwYXNz"],
    ["a bearer that is not a JWT", "Bearer not-a-jwt"],
  ] as const)("a request with %s gets 401 and the challenge", async (_name, authorization) => {
    const run = await runFiles(files(), { authorize: allowAll }, authorization);

    expect(run.status).toBe(401);
    expect(run.response.headers.get("WWW-Authenticate")).toBe(CHALLENGE);
    expect(run.response.headers.get("Cache-Control")).toBe("no-store");
    expect(run.nextCalled).toBe(false);
    expect(run.authorizeCalls).toBe(0);
  });

  test("a tampered token, or one for another package, gets the challenge", async () => {
    const parts = (await mintMiniappToken(TEST_PACKAGE)).split(".");
    parts[1] = parts[1]!.replace(/.$/, parts[1]!.endsWith("A") ? "B" : "A");

    for (const token of [parts.join("."), await mintMiniappToken("com.other.app")]) {
      const run = await runFiles(files(), { authorize: allowAll }, `Bearer ${token}`);
      expect(run.status).toBe(401);
      expect(run.response.headers.get("WWW-Authenticate")).toBe(CHALLENGE);
      expect(run.nextCalled).toBe(false);
      expect(run.authorizeCalls).toBe(0);
    }
  });

  test("an expired token gets the challenge again", async () => {
    const expired = await mintMiniappToken(TEST_PACKAGE, { expirationTime: Math.floor(Date.now() / 1000) - 60 });

    const run = await runFiles(files({ clockTolerance: 0 }), { authorize: allowAll }, `Bearer ${expired}`);

    expect(run.status).toBe(401);
    expect(run.response.headers.get("WWW-Authenticate")).toBe(CHALLENGE);
    expect(run.nextCalled).toBe(false);
  });

  test("a token authorize refuses gets 403, without a challenge", async () => {
    const token = await mintMiniappToken(TEST_PACKAGE, { claims: { workspaceId: "ws_other" } });

    const run = await runFiles(
      files(),
      { authorize: (session) => session.workspaceId === "ws_acme" },
      `Bearer ${token}`,
    );

    expect(run.status).toBe(403);
    expect(run.authorizeCalls).toBe(1);
    expect(run.response.headers.get("WWW-Authenticate")).toBeNull();
    expect(run.response.headers.get("Cache-Control")).toBe("no-store");
    expect(run.nextCalled).toBe(false);
    expect(run.values.has("mentraAuth")).toBe(false);
  });

  test("anything but true from authorize is a refusal", async () => {
    const token = await mintMiniappToken(TEST_PACKAGE);

    for (const answer of [false, undefined, 1, "yes", {}]) {
      const authorize = (async () => answer) as unknown as () => Promise<boolean>;
      const run = await runFiles(files(), { authorize }, `Bearer ${token}`);
      expect(run.status).toBe(403);
      expect(run.nextCalled).toBe(false);
    }
  });

  test("an admitted token reaches the files, with the verified session on the context", async () => {
    const token = await mintMiniappToken(TEST_PACKAGE, { claims: { workspaceId: "ws_acme" } });
    let authorizedWith: VerifiedMentraAuth | undefined;

    const run = await runFiles(
      files(),
      {
        authorize: async (session, c) => {
          authorizedWith = session;
          return session.workspaceId === "ws_acme" && c.req.header("Authorization") === `Bearer ${token}`;
        },
      },
      `Bearer ${token}`,
    );

    expect(run.nextCalled).toBe(true);
    expect(run.status).toBe(200);
    expect(await run.response.text()).toBe("miniapp.json");
    expect(authorizedWith?.workspaceId).toBe("ws_acme");
    expect((run.values.get("mentraAuth") as VerifiedMentraAuth).mentraUserId).toBe("user_123");
  });

  test("contextKey names the context variable", async () => {
    const run = await runFiles(
      files(),
      { authorize: allowAll, contextKey: "viewer" },
      `Bearer ${await mintMiniappToken(TEST_PACKAGE)}`,
    );

    expect(run.values.has("mentraAuth")).toBe(false);
    expect((run.values.get("viewer") as VerifiedMentraAuth).mentraUserId).toBe("user_123");
  });

  test("an admitted file is kept out of shared caches", async () => {
    const token = `Bearer ${await mintMiniappToken(TEST_PACKAGE)}`;
    const cases: Array<[string | null, string]> = [
      [null, "private"],
      ["public, max-age=31536000, immutable", "private, max-age=31536000, immutable"],
      ["max-age=60, s-maxage=600", "private, max-age=60"],
      ["no-cache", "private, no-cache"],
      ["private, no-store", "private, no-store"],
      ["Public,  S-MAXAGE = 5 ,must-revalidate", "private, must-revalidate"],
    ];

    for (const [downstream, expected] of cases) {
      const headers: Record<string, string> = downstream === null ? {} : { "Cache-Control": downstream };
      const run = await runFiles(files(), { authorize: allowAll }, token, new Response("miniapp.json", { headers }));
      expect(run.response.headers.get("Cache-Control")).toBe(expected);
    }
  });

  test("a refusal keeps the headers earlier middleware put on c.json's responses", async () => {
    const context = fakeContext(undefined);
    const json = context.c.json;
    context.c.json = (body, status) => {
      const response = json(body, status);
      response.headers.set("Access-Control-Allow-Origin", "*");
      return response;
    };

    const result = (await files().miniappFiles({ authorize: allowAll })(context.c, async () => {})) as Response;

    expect(result.status).toBe(401);
    expect(result.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(result.headers.get("WWW-Authenticate")).toBe(CHALLENGE);
    expect(await result.json()).toEqual({ error: "sign_in_required" });
  });

  test("a context without header and res still reaches the files", async () => {
    const token = await mintMiniappToken(TEST_PACKAGE);
    let nextCalled = false;

    const result = await files().miniappFiles({ authorize: allowAll })(
      {
        req: { header: () => `Bearer ${token}` },
        set: () => {},
        json: (body, status = 200) => Response.json(body, { status }),
      },
      async () => {
        nextCalled = true;
      },
    );

    expect(nextCalled).toBe(true);
    expect(result).toBeUndefined();
  });

  test("a local-build token gets 403 unless local builds are allowed", async () => {
    await withEnv({}, async () => {
      const token = `Bearer ${await mintMiniappToken(TEST_PACKAGE, { claims: { localBuild: true } })}`;

      const refused = await runFiles(files(), { authorize: allowAll }, token);
      expect(refused.status).toBe(403);
      expect(refused.response.headers.get("WWW-Authenticate")).toBeNull();
      expect(refused.authorizeCalls).toBe(0);
      expect(refused.nextCalled).toBe(false);

      const allowed = await runFiles(
        files({ allowLocalBuilds: true }),
        { authorize: (session) => session.localBuild },
        token,
      );
      expect(allowed.status).toBe(200);
      expect(allowed.nextCalled).toBe(true);
    });
  });

  test("an error thrown by authorize propagates and never reaches the files", async () => {
    const token = await mintMiniappToken(TEST_PACKAGE);
    let nextCalled = false;

    await expect(
      files().miniappFiles({
        authorize: () => {
          throw new Error("membership lookup failed");
        },
      })(fakeContext(`Bearer ${token}`).c, async () => {
        nextCalled = true;
      }),
    ).rejects.toThrow("membership lookup failed");
    expect(nextCalled).toBe(false);
  });

  test("a package name that cannot be quoted in the challenge is refused when the middleware is made", () => {
    const auth = createMentraAuth({ packageName: 'com.example."quoted"', jwksUrl });
    expect(() => auth.miniappFiles({ authorize: allowAll })).toThrow(MentraAuthError);
    expect(() => mentraSignInChallenge("com.example\r\nx")).toThrow(MentraAuthError);
  });

  test("miniappFiles without an authorize function is refused when the middleware is made", () => {
    const make = files().miniappFiles as (options?: unknown) => unknown;
    expect(() => make.call(files(), {})).toThrow(expect.objectContaining({ code: "invalid_configuration" }));
    expect(() => make.call(files())).toThrow(expect.objectContaining({ code: "invalid_configuration" }));
  });
});

/**
 * A Hono-shaped context: `res` and `header` behave like Hono's, so a header set
 * after `next()` lands on the response the files handler produced.
 */
function fakeContext(authorization?: string) {
  const values = new Map<string, unknown>();
  let res = new Response(null, { status: 404 });
  const c: HonoLikeContext = {
    req: { header: (name) => (name.toLowerCase() === "authorization" ? authorization : undefined) },
    set: (key, value) => values.set(key, value),
    json: (body, status = 200) => Response.json(body, { status }),
    get res() {
      return res;
    },
    header: (name, value) => {
      res = new Response(res.body, res);
      res.headers.set(name, value);
    },
  };
  return {
    c,
    values,
    serve: (response: Response) => {
      res = response;
    },
    response: () => res,
  };
}

/**
 * Run `auth.miniappFiles(options)` on one request whose downstream handler
 * serves `downstream`, counting the calls to `authorize`.
 */
async function runFiles(
  auth: MentraAuth,
  options: MentraMiniappFilesOptions,
  authorization: string | undefined,
  downstream: Response = new Response("miniapp.json"),
) {
  const context = fakeContext(authorization);
  let nextCalled = false;
  let authorizeCalls = 0;
  const result = await auth.miniappFiles({
    ...options,
    authorize: (session, c) => {
      authorizeCalls += 1;
      return options.authorize(session, c);
    },
  })(context.c, async () => {
    nextCalled = true;
    context.serve(downstream);
  });
  // A refusal is the returned response; an admitted request leaves it on the context, as in Hono.
  const response = result instanceof Response ? result : context.response();
  return { response, status: response.status, nextCalled, authorizeCalls, values: context.values };
}

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
  const names = [
    "MENTRA_AUTH_JWKS_URL",
    "MENTRA_AUTH_JWKS_URLS",
    "MENTRA_AUTH_ISSUER",
    "MENTRA_AUTH_ISSUERS",
    "MENTRA_AUTH_ALLOW_LOCAL_BUILDS",
    "MENTRA_CORE_URL",
  ];
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
