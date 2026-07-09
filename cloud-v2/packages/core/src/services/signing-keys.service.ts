/**
 * @fileoverview Signing keys and the public JWKS.
 *
 * Owns everything crypto-key: lazy-loading Mentra's Ed25519 signing keypairs
 * from env (access, miniapp, account), the `kid` constants, and building the
 * public `/.well-known/jwks.json` document. Split out of session.service so
 * that file is about session lifecycle, not key management (issue 019).
 *
 * Keys are loaded lazily on first use and cached; `resetSigningKeyCache` exists
 * for tests that mutate the key env vars mid-process.
 */
import * as jose from "jose";
import { createLogger } from "@mentra/cloud-shared";
import { OauthServerError } from "../types/oauth.types";

const logger = createLogger("core").child({ service: "signing-keys.service" });

export const MENTRA_ALG = "EdDSA";

// Each token type is signed with its own key, tagged by `kid` so verifiers pick
// the right public key from the JWKS. Distinct keys keep a leak's blast radius
// to one token type.
export const ACCESS_TOKEN_KID = "mentra-access-1";
export const RUNTIME_TOKEN_KID = "cloud-core-runtime-1";
export const MINIAPP_TOKEN_KID = "mentra-miniapp-1";
export const ACCOUNT_TOKEN_KID = "mentra-account-1";

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new OauthServerError(`env var ${name} is not set`);
  return v;
}

/**
 * Reconstruct a PEM block from a stored base64 body. We store only the body to
 * keep env values short and free of `\n` escapes; the wrapper is
 * informationless for Ed25519 (always PKCS#8 / SPKI).
 */
function toPem(base64Body: string, label: "PRIVATE KEY" | "PUBLIC KEY"): string {
  return `-----BEGIN ${label}-----\n${base64Body}\n-----END ${label}-----`;
}

async function loadKeypair(
  privEnv: string,
  pubEnv: string,
  label: string,
): Promise<{ privateKey: jose.KeyLike; publicKey: jose.KeyLike }> {
  const [privateKey, publicKey] = await Promise.all([
    jose.importPKCS8(toPem(requireEnv(privEnv), "PRIVATE KEY"), MENTRA_ALG, { extractable: false }),
    // Public key stays extractable so we can export it to JWK for the JWKS.
    jose.importSPKI(toPem(requireEnv(pubEnv), "PUBLIC KEY"), MENTRA_ALG, { extractable: true }),
  ]);
  logger.info(`loaded Mentra ${label} signing keypair`);
  return { privateKey, publicKey };
}

let mentraKeys: Promise<{ privateKey: jose.KeyLike; publicKey: jose.KeyLike }> | null = null;
let miniappKeys: Promise<{ privateKey: jose.KeyLike; publicKey: jose.KeyLike }> | null = null;
let accountKeys: Promise<{ privateKey: jose.KeyLike; publicKey: jose.KeyLike }> | null = null;

export async function getMentraKeys() {
  if (!mentraKeys) mentraKeys = loadKeypair("MENTRA_JWT_PRIVATE_KEY", "MENTRA_JWT_PUBLIC_KEY", "access-token");
  return mentraKeys;
}

export async function getMiniappKeys() {
  // Falling back to the access-token key is intentionally NOT done: the keys
  // must be distinct for the blast-radius guarantee.
  if (!miniappKeys) {
    miniappKeys = loadKeypair("MENTRA_MINIAPP_JWT_PRIVATE_KEY", "MENTRA_MINIAPP_JWT_PUBLIC_KEY", "miniapp-token");
  }
  return miniappKeys;
}

export async function getAccountKeys() {
  if (!accountKeys) {
    accountKeys = loadKeypair("MENTRA_ACCOUNT_JWT_PRIVATE_KEY", "MENTRA_ACCOUNT_JWT_PUBLIC_KEY", "account-token");
  }
  return accountKeys;
}

/** Whether the account signing keypair is configured. Environments deployed
 * before the account rollout run with the feature dark; everything account-key
 * dependent (JWKS entry, OEM-row seeding) must degrade gracefully, not 500. */
export function accountKeysConfigured(): boolean {
  return Boolean(
    process.env.MENTRA_ACCOUNT_JWT_PRIVATE_KEY && process.env.MENTRA_ACCOUNT_JWT_PUBLIC_KEY,
  );
}

/**
 * Reset the lazy-loaded signing keypair caches. **Test-only.** Production has no
 * reason to rotate keys mid-process; tests that mutate the key env vars between
 * files in the same Bun process need to discard the cached imports.
 */
export function resetSigningKeyCache(): void {
  mentraKeys = null;
  miniappKeys = null;
  accountKeys = null;
}

/** The account signing public key in SPKI PEM form, for seeding the `mentra`
 * OEM row (static key mode). */
export function getAccountPublicKeyPem(): string {
  return toPem(requireEnv("MENTRA_ACCOUNT_JWT_PUBLIC_KEY"), "PUBLIC KEY");
}

/**
 * Build the public JWKS document Mentra publishes at /.well-known/jwks.json.
 * Each public key is tagged with its `kid` so a verifier picks the right one:
 *   - access-token key (internal services verify access tokens),
 *   - runtime-token key (Runtime trusts Core-brokered runtime tokens),
 *   - miniapp-token key (developer backends verify miniapp tokens),
 *   - account-token key (audit visibility for Mentra's own OEM subject tokens).
 * Publishing keys ahead of need makes rotation a no-coordination change.
 */
export async function getPublicJwks(): Promise<{ keys: jose.JWK[] }> {
  const [access, miniapp] = await Promise.all([getMentraKeys(), getMiniappKeys()]);
  const [accessJwk, miniappJwk] = await Promise.all([
    jose.exportJWK(access.publicKey),
    jose.exportJWK(miniapp.publicKey),
  ]);
  const keys: jose.JWK[] = [
    { ...accessJwk, alg: MENTRA_ALG, use: "sig", kid: ACCESS_TOKEN_KID },
    { ...accessJwk, alg: MENTRA_ALG, use: "sig", kid: RUNTIME_TOKEN_KID },
    { ...miniappJwk, alg: MENTRA_ALG, use: "sig", kid: MINIAPP_TOKEN_KID },
  ];
  // The account key is optional: environments deployed before the account env
  // vars exist must keep serving the access/runtime/miniapp keys (the startup
  // migration skips the mentra OEM seed the same way).
  if (accountKeysConfigured()) {
    const account = await getAccountKeys();
    const accountJwk = await jose.exportJWK(account.publicKey);
    keys.push({ ...accountJwk, alg: MENTRA_ALG, use: "sig", kid: ACCOUNT_TOKEN_KID });
  }
  return { keys };
}
