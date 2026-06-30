/**
 * verify-token-env.ts — prove the multi-environment JWKS fallback against a REAL
 * miniapp token.
 *
 * A miniapp that uses the auto-auth system receives a real, env-signed token in
 * its `Authorization` header (cloud-client mints it via
 * POST /api/client/auth/miniapp-token using the device's user session). Capture
 * that token and pass it here. The script fetches every Mentra environment's
 * live JWKS and reports which environment's key validates the signature — which
 * is exactly the decision the fallback in `@mentra/auth` makes.
 *
 * Usage:
 *   bun run cloud-v2/docs/issues/017-auth-jwks-multi-env-fallback/verify-token-env.ts <token>
 *   MENTRA_TOKEN=<token> bun run .../verify-token-env.ts
 *   # optional: override the endpoint list (comma-separated) for local/self-hosted
 *   MENTRA_JWKS_URLS=http://localhost:3000/.well-known/jwks.json bun run .../verify-token-env.ts <token>
 */
import * as jose from "jose";
import { MENTRA_JWKS_URLS, createMentraAuth } from "../src/index";

const ENV_LABELS = ["prod", "staging", "dev", "debug"];

function urlList(): string[] {
  const override = process.env.MENTRA_JWKS_URLS?.split(",").map((s) => s.trim()).filter(Boolean);
  return override && override.length > 0 ? override : MENTRA_JWKS_URLS;
}

function labelFor(index: number, url: string): string {
  if (process.env.MENTRA_JWKS_URLS) return new URL(url).host;
  return ENV_LABELS[index] ?? `env-${index}`;
}

function decode(token: string): { header: jose.ProtectedHeaderParameters; payload: jose.JWTPayload } {
  return {
    header: jose.decodeProtectedHeader(token),
    payload: jose.decodeJwt(token),
  };
}

async function main() {
  const token = process.argv[2] ?? process.env.MENTRA_TOKEN;
  if (!token) {
    console.error("No token. Pass it as an argument or set MENTRA_TOKEN.");
    process.exit(2);
  }

  const { header, payload } = decode(token);
  console.log("Token header:", JSON.stringify({ alg: header.alg, kid: header.kid }));
  console.log(
    "Token claims:",
    JSON.stringify({
      iss: payload.iss,
      aud: payload.aud,
      sub: payload.sub,
      exp: payload.exp,
      expired: typeof payload.exp === "number" ? payload.exp * 1000 < Date.now() : "n/a",
    }),
  );
  console.log("");

  const urls = urlList();
  let matched: string | null = null;

  // Signature-only check per environment: no issuer/audience pin and a huge clock
  // tolerance, so the ONLY thing under test is whether this env's key signed the
  // token. This isolates env-selection from claim validation.
  for (let i = 0; i < urls.length; i++) {
    const label = labelFor(i, urls[i]);
    const jwks = jose.createRemoteJWKSet(new URL(urls[i]), { timeoutDuration: 8_000 });
    try {
      await jose.jwtVerify(token, jwks, { algorithms: ["EdDSA"], clockTolerance: "3650 days" });
      console.log(`  [PASS] ${label.padEnd(8)} signature verified by this environment's key`);
      matched = matched ?? label;
    } catch (err) {
      const code = (err as { code?: string }).code ?? (err as Error).name;
      console.log(`  [ fail] ${label.padEnd(8)} ${code}`);
    }
  }

  console.log("");
  if (matched) {
    console.log(`==> Signature belongs to: ${matched}`);
  } else {
    console.log("==> No Mentra environment validated this signature.");
  }

  // Now the real API path: this is what a miniapp backend actually runs. It walks
  // the same fallback list and additionally enforces audience/issuer/expiry.
  const audience = typeof payload.aud === "string" ? payload.aud : Array.isArray(payload.aud) ? payload.aud[0] : "";
  console.log("");
  console.log(`createMentraAuth({ packageName: "${audience}" }).verifyToken(...) →`);
  try {
    const auth = createMentraAuth({
      packageName: audience,
      ...(process.env.MENTRA_JWKS_URLS ? { jwksUrls: urls } : {}),
    });
    const verified = await auth.verifyToken(token);
    console.log("  OK:", JSON.stringify({ mentraUserId: verified.mentraUserId, tenantId: verified.tenantId, packageName: verified.packageName }));
  } catch (err) {
    console.log("  REJECTED:", (err as Error).message);
    console.log("  (a signature match above with a REJECTED here usually means the token simply expired)");
  }
}

main();
