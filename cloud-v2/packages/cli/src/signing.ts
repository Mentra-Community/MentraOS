import crypto from "node:crypto";
import { readFileSync } from "node:fs";

import { listSigningKeys, registerSigningKey, type SignedBundleMetadata } from "./api";
import { loadSigningKey, saveSigningKey, type CliCredentials, type CliJwk, type CliSigningKey } from "./credentials";

export interface DevMiniappAttestation {
  packageName: string;
  devServerUrl: string;
  nonce: string;
  expiresAt: string;
  signingKeyId: string;
  signature: string;
}

export async function ensureSigningKey(credentials: CliCredentials): Promise<CliSigningKey> {
  const stored = await loadSigningKey(credentials.coreUrl);
  if (stored && await remoteKeyIsActive(credentials, stored.signingKeyId)) return stored;

  const pair = crypto.generateKeyPairSync("ed25519");
  const publicKeyJwk = pair.publicKey.export({ format: "jwk" }) as CliJwk;
  const privateKeyJwk = pair.privateKey.export({ format: "jwk" }) as CliJwk;
  const { key } = await registerSigningKey(credentials, { publicKeyJwk });
  const localKey: CliSigningKey = {
    coreUrl: credentials.coreUrl,
    signingKeyId: key.id,
    publicKeyJwk,
    privateKeyJwk,
    createdAt: new Date().toISOString(),
  };
  await saveSigningKey(localKey);
  return localKey;
}

export function signBundleMetadata(input: {
  signingKey: CliSigningKey;
  packageName: string;
  version: string;
  manifest: Record<string, unknown>;
  bundle: Uint8Array;
}): SignedBundleMetadata {
  const payload = {
    packageName: input.packageName,
    version: input.version,
    bundleSha256: sha256Hex(input.bundle),
    manifestSha256: sha256Hex(Buffer.from(canonicalJson(input.manifest))),
    createdAt: new Date().toISOString(),
  };
  return {
    signingKeyId: input.signingKey.signingKeyId,
    payload,
    signature: signPayload(input.signingKey.privateKeyJwk, payload),
  };
}

export function signDevAttestation(input: {
  signingKey: CliSigningKey;
  packageName: string;
  devServerUrl: string;
  ttlMs?: number;
}): DevMiniappAttestation {
  const payload = {
    packageName: input.packageName,
    devServerUrl: input.devServerUrl,
    nonce: crypto.randomUUID(),
    expiresAt: new Date(Date.now() + (input.ttlMs ?? 15 * 60_000)).toISOString(),
    signingKeyId: input.signingKey.signingKeyId,
  };
  return {
    ...payload,
    signature: signPayload(input.signingKey.privateKeyJwk, payload),
  };
}

export function encodeDevAttestation(attestation: DevMiniappAttestation): string {
  return Buffer.from(JSON.stringify(attestation)).toString("base64url");
}

export function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function fileSha256Hex(path: string): string {
  return sha256Hex(readFileSync(path));
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function signPayload(privateKeyJwk: CliJwk, payload: unknown): string {
  const privateKey = crypto.createPrivateKey({ key: privateKeyJwk, format: "jwk" } as unknown as crypto.PrivateKeyInput);
  return crypto.sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString("base64url");
}

async function remoteKeyIsActive(credentials: CliCredentials, signingKeyId: string): Promise<boolean> {
  try {
    const { keys } = await listSigningKeys(credentials);
    return keys.some(key => key.id === signingKeyId && key.status === "active");
  } catch {
    return false;
  }
}
