/**
 * @fileoverview Ed25519 keypair loading for TEST OEM.
 *
 * Two modes:
 *   1. **Env-provided** (preferred for tests and CI): `TEST_OEM_PRIVATE_KEY`
 *      env var holds the base64 body of a PKCS#8 Ed25519 private key. We
 *      reconstruct the PEM wrapper, import, and derive the public half.
 *   2. **Auto-generated** (preferred for local exploration): if no env key
 *      is set, generate a fresh keypair at boot and log the base64 body so
 *      the operator can paste it into `oems.publicKey` during testing.
 */

import crypto from "node:crypto";
import * as jose from "jose";

const ALG = "EdDSA";

export interface TestOemKeypair {
  /** For signing JWTs we issue. */
  privateKey: jose.KeyLike;
  /** Exposed via `.well-known/jwks.json`. */
  publicKey: jose.KeyLike;
  /** Base64 body of the SPKI public key, ready to paste into core's `oems.publicKey`. */
  publicKeyBody: string;
  /** JWK form of the public key, for the JWKS endpoint. */
  publicJwk: jose.JWK;
}

export async function loadKeypair(opts: { kid: string }): Promise<TestOemKeypair> {
  const privBody = process.env.TEST_OEM_PRIVATE_KEY?.trim();

  if (privBody) {
    return importFromBase64Body(privBody, opts.kid);
  }
  return generateFresh(opts.kid);
}

async function importFromBase64Body(
  base64Body: string,
  kid: string,
): Promise<TestOemKeypair> {
  const privatePem = toPem(base64Body, "PRIVATE KEY");
  const privateKeyObj = crypto.createPrivateKey(privatePem);
  const publicKeyObj = crypto.createPublicKey(privateKeyObj);

  const publicPem = publicKeyObj.export({ type: "spki", format: "pem" }).toString();
  const publicKeyBody = stripPemWrapper(publicPem);

  const [privateKey, publicKey] = await Promise.all([
    jose.importPKCS8(privatePem, ALG, { extractable: false }),
    jose.importSPKI(publicPem, ALG, { extractable: true }),
  ]);

  const publicJwk = { ...(await jose.exportJWK(publicKey)), alg: ALG, use: "sig", kid };

  return { privateKey, publicKey, publicKeyBody, publicJwk };
}

async function generateFresh(kid: string): Promise<TestOemKeypair> {
  const { privateKey: nodePriv, publicKey: nodePub } = crypto.generateKeyPairSync("ed25519");
  const privatePem = nodePriv.export({ type: "pkcs8", format: "pem" }).toString();
  const publicPem = nodePub.export({ type: "spki", format: "pem" }).toString();

  const privateBody = stripPemWrapper(privatePem);
  const publicKeyBody = stripPemWrapper(publicPem);

  console.log("[test-oem] no TEST_OEM_PRIVATE_KEY set; generated fresh keypair.");
  console.log(`[test-oem]   TEST_OEM_PRIVATE_KEY=${privateBody}`);
  console.log(`[test-oem]   public key body (paste into oems.publicKey): ${publicKeyBody}`);

  const [privateKey, publicKey] = await Promise.all([
    jose.importPKCS8(privatePem, ALG, { extractable: false }),
    jose.importSPKI(publicPem, ALG, { extractable: true }),
  ]);

  const publicJwk = { ...(await jose.exportJWK(publicKey)), alg: ALG, use: "sig", kid };

  return { privateKey, publicKey, publicKeyBody, publicJwk };
}

function toPem(base64Body: string, label: "PRIVATE KEY" | "PUBLIC KEY"): string {
  return `-----BEGIN ${label}-----\n${base64Body}\n-----END ${label}-----`;
}

function stripPemWrapper(pem: string): string {
  return pem
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "");
}
