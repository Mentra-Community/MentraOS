import crypto from "node:crypto";

import { canonicalJson, type DeveloperJwk } from "./developer-signing.service";
import type { VerifiedZipEntry } from "./zip-archive";

export const MENTRA_BUNDLE_SIGNATURE_PATH = "META-INF/MENTRA.SIG";
export const MAX_BUNDLE_SIGNATURE_BYTES = 16 * 1024;

export interface VerifiedPublisherIdentity {
  publisherKeyFingerprint: string;
  publisherPublicKeyJwk: DeveloperJwk;
  contentSha256: string;
}

export function verifyEmbeddedPublisherSignature(input: {
  entries: Map<string, VerifiedZipEntry>;
  packageName: string;
  version: string;
  manifestSha256: string;
}): VerifiedPublisherIdentity {
  const candidates = [...input.entries.values()].filter(
    entry => !entry.directory && entry.name.toLowerCase() === MENTRA_BUNDLE_SIGNATURE_PATH.toLowerCase(),
  );
  if (candidates.length !== 1 || candidates[0]?.name !== MENTRA_BUNDLE_SIGNATURE_PATH || !candidates[0].bytes) {
    throw new PublisherBundleSignatureError(
      "missing_bundle_signature",
      `bundle must contain exactly one ${MENTRA_BUNDLE_SIGNATURE_PATH}`,
    );
  }
  let envelope: PublisherSignatureEnvelope;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(candidates[0].bytes);
    envelope = validateEnvelope(JSON.parse(decoded));
  } catch (error) {
    if (error instanceof PublisherBundleSignatureError) throw error;
    throw new PublisherBundleSignatureError(
      "invalid_bundle_signature",
      `bundle signature entry is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const files = [...input.entries.values()]
    .filter(entry => !entry.directory && entry.name !== MENTRA_BUNDLE_SIGNATURE_PATH)
    .map(entry => ({ path: entry.name, size: entry.uncompressedSize, sha256: entry.sha256 }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const contentSha256 = crypto
    .createHash("sha256")
    .update(canonicalJson({ schemaVersion: 1, files }))
    .digest("hex");
  const expectedPayload = {
    packageName: input.packageName,
    version: input.version,
    manifestSha256: input.manifestSha256,
    contentSha256,
  };
  if (canonicalJson(envelope.payload) !== canonicalJson(expectedPayload)) {
    throw new PublisherBundleSignatureError(
      "bundle_signature_payload_mismatch",
      "bundle signature payload does not match the uploaded archive",
    );
  }
  const fingerprint = publisherKeyFingerprint(envelope.publicKeyJwk);
  if (fingerprint !== envelope.publisherKeyFingerprint) {
    throw new PublisherBundleSignatureError(
      "bundle_signer_fingerprint_mismatch",
      "bundle publisher fingerprint does not match its public key",
    );
  }
  try {
    const publicKey = crypto.createPublicKey({
      key: envelope.publicKeyJwk,
      format: "jwk",
    } as unknown as crypto.PublicKeyInput);
    const ok = crypto.verify(
      null,
      Buffer.from(canonicalJson(envelope.payload)),
      publicKey,
      decodeSignature(envelope.signature),
    );
    if (!ok) throw new Error("signature mismatch");
  } catch {
    throw new PublisherBundleSignatureError("invalid_bundle_signature", "bundle publisher signature is invalid");
  }
  return { publisherKeyFingerprint: fingerprint, publisherPublicKeyJwk: envelope.publicKeyJwk, contentSha256 };
}

function decodeSignature(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid signature encoding");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== 64 || decoded.toString("base64url") !== value) {
    throw new Error("invalid signature encoding");
  }
  return decoded;
}

export function publisherKeyFingerprint(jwk: DeveloperJwk): string {
  if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new PublisherBundleSignatureError(
      "invalid_publisher_key",
      "bundle publisher key must be an Ed25519 public JWK",
    );
  }
  if (!/^[A-Za-z0-9_-]+$/.test(jwk.x)) {
    throw new PublisherBundleSignatureError("invalid_publisher_key", "bundle publisher key is not valid base64url");
  }
  const raw = Buffer.from(jwk.x, "base64url");
  if (raw.toString("base64url") !== jwk.x) {
    throw new PublisherBundleSignatureError("invalid_publisher_key", "bundle publisher key is not canonical base64url");
  }
  if (raw.byteLength !== 32) {
    throw new PublisherBundleSignatureError("invalid_publisher_key", "bundle publisher key must contain 32 bytes");
  }
  return `sha256:${crypto.createHash("sha256").update(raw).digest("hex")}`;
}

export class PublisherBundleSignatureError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PublisherBundleSignatureError";
  }
}

interface PublisherSignatureEnvelope {
  schemaVersion: 1;
  algorithm: "Ed25519";
  publicKeyJwk: DeveloperJwk;
  publisherKeyFingerprint: string;
  payload: {
    packageName: string;
    version: string;
    manifestSha256: string;
    contentSha256: string;
  };
  signature: string;
}

function validateEnvelope(value: unknown): PublisherSignatureEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PublisherBundleSignatureError("invalid_bundle_signature", "bundle signature must be an object");
  }
  const candidate = value as Partial<PublisherSignatureEnvelope>;
  if (candidate.schemaVersion !== 1 || candidate.algorithm !== "Ed25519") {
    throw new PublisherBundleSignatureError("unsupported_bundle_signature", "unsupported bundle signature schema");
  }
  if (
    !candidate.publicKeyJwk ||
    typeof candidate.publisherKeyFingerprint !== "string" ||
    typeof candidate.signature !== "string" ||
    !candidate.payload ||
    typeof candidate.payload.packageName !== "string" ||
    typeof candidate.payload.version !== "string" ||
    !/^[a-f0-9]{64}$/.test(candidate.payload.manifestSha256) ||
    !/^[a-f0-9]{64}$/.test(candidate.payload.contentSha256)
  ) {
    throw new PublisherBundleSignatureError("invalid_bundle_signature", "bundle signature fields are invalid");
  }
  return candidate as PublisherSignatureEnvelope;
}
